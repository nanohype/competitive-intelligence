# competitive-intelligence chart

Helm chart for the competitive-intelligence radar. Renders into a Platform tenant on the `eks-agent-platform` operator running on a nanohype-org EKS cluster.

The workload is a single long-lived worker: a scheduler that runs one global crawl on an interval, the crawler that fetches competitor sites, the semantic-diff pipeline, and a Slack bot in Socket Mode (outbound WebSocket). There is no inbound HTTP product surface — the only port served is the health port for probes.

## Files

- `Chart.yaml` — chart metadata
- `values.yaml` — base values (all environments)
- `values-dev.yaml` / `values-staging.yaml` / `values-production.yaml` — per-env deltas
- `templates/`
  - `deployment.yaml` — the worker pod. Non-root, `readOnlyRootFilesystem` with a `/tmp` emptyDir, env from `values.env` + `tenantInfra.pg*`, secrets via `envFrom: secretRef`, liveness `/health` + readiness `/readyz` on the health port, `checksum/external-secret` pod-roll annotation. `replicaCount: 1` with a `Recreate` strategy — single-writer scheduler + crawl mutex; never run two at once.
  - `service.yaml` — ClusterIP on the health port (default 3000)
  - `serviceaccount.yaml` — IRSA annotation fed by `aws.platformRoleArn` (per-env), pointing at the landing-zone-owned `competitive-intelligence-platform` IRSA role. No inline IAM.
  - `externalsecret.yaml` — pulls Slack tokens + optional provider keys from `competitive-intelligence/<env>/app-secrets` and `PGUSER`/`PGPASSWORD` from `competitive-intelligence/<env>/db-credentials`
  - `networkpolicy.yaml` — default-deny + egress allow-list (DNS, HTTPS to the open internet minus IMDS, Postgres to the VPC CIDR); ingress is same-namespace probes only
  - `prometheusrule.yaml` — alerts: crawl-failure spike, circuit-breaker open, alert-send failure, pgvector unreachable
  - `grafana-dashboard.yaml` — ConfigMap (labeled `grafana_dashboard: "1"`) loading the dashboard from `dashboards/competitive-intelligence.json`
  - `_helpers.tpl` — name/label helpers

## Relationship to companion files

The chart alone is not enough to run the app. Two sibling files at the repo root complete the tenant trio:

- `../platform.yaml` — Platform CR + BudgetPolicy declaring this app as a tenant of the `protohype` team. The operator reconciles the Namespace, ResourceQuota, default-deny NetworkPolicy, ArgoCD AppProject, and the per-tenant IRSA role from this CR. Apply once during initial setup.
- `../gitops/applicationset-entry.yaml` — ApplicationSet entry registered into `nanohype/eks-gitops`. ArgoCD picks up the entry and rolls out this chart per cluster/env.

## Required landing-zone component

Single-tenant component `components/aws/competitive-intelligence-platform/` provisions everything the pod needs:

- Aurora Serverless v2 (PostgreSQL + pgvector at app bootstrap) — the durable vector store that survives restarts, so the first post-restart crawl diffs against real history instead of re-flooding alerts
- IRSA role with the inline policy: Bedrock `InvokeModel` for Claude Sonnet + Titan Embed v2, Secrets Manager read scoped to `competitive-intelligence/<env>/*`, CloudWatch `PutMetricData`
- Secrets Manager entries: `competitive-intelligence/<env>/app-secrets` (Slack + optional provider keys) and the Aurora-managed `competitive-intelligence/<env>/db-credentials`

## IRSA wiring

The chart's `serviceaccount.yaml` annotates `eks.amazonaws.com/role-arn` with `.Values.aws.platformRoleArn`. Per-env values plumb in the landing-zone output:

```sh
# Production
tofu -chdir=live/aws/workload-prod/us-west-2/production/competitive-intelligence-platform output -raw irsa_role_arn
```

Drop that into `chart/values-production.yaml` under `aws.platformRoleArn`. ArgoCD reads the per-env values at render time; pod restart picks up the SA annotation; the pod `AssumeRoleWithWebIdentity` into the role on the next AWS call. Bedrock uses the AWS credential chain, which resolves to this role on-cluster — no API keys.

## LLM

Bedrock is the default LLM provider (`LLM_PROVIDER=bedrock`), authenticated via IRSA. The model is pinned in `values.yaml` (`BEDROCK_LLM_MODEL: anthropic.claude-sonnet-4-6`, the llm-policy Sonnet default tier) — verify model availability in the target region before promoting, since cross-region inference profiles differ. Anthropic and OpenAI remain pluggable alternates; their keys arrive through the ExternalSecret only when those providers are selected.

## Render locally

```sh
helm lint chart
helm template competitive-intelligence chart -f chart/values.yaml -f chart/values-production.yaml > rendered.yaml
```

`aws.platformRoleArn` and `tenantInfra.pgHost` are empty at the chart level, so a local render omits the IRSA annotation and falls back to local-dev defaults — no real AWS resources required for a smoke render.

## Where the rest lives

This chart owns the app's k8s surface. The cloud substrate and cluster addons sit in other layers:

**Substrate (`landing-zone/components/aws/competitive-intelligence-platform/`):** Aurora Serverless v2 (pgvector), the IRSA role, and the seeded Secrets Manager entries. Its `irsa_role_arn` output feeds `aws.platformRoleArn`; `aurora_cluster_endpoint` feeds `tenantInfra.pgHost`. AWS Secrets Manager stays the source of truth; `externalsecret.yaml` syncs it into a k8s Secret via ESO.

**Cluster addons (`eks-gitops`):** the external-secrets operator + `aws-secrets-manager` ClusterSecretStore, the OTel Collector at `otel-collector.observability.svc.cluster.local:4318`, the cluster log forwarder, kube-prometheus-stack, and Alertmanager. The app writes structured JSON to stderr → cluster log forwarder → Loki, and exports OTLP traces + metrics to the cluster collector → Tempo + Mimir. No per-pod sidecars.

**This chart:** the worker `Deployment`, the default-deny `networkpolicy.yaml`, the `externalsecret.yaml`, plus the observability that ships here rather than in eks-gitops:

- `prometheusrule.yaml` — crawl-failure, circuit-breaker-open, alert-send-failure, and pgvector-unreachable alerts. Alertmanager (eks-gitops) routes them.
- `grafana-dashboard.yaml` — a ConfigMap labeled `grafana_dashboard: "1"` loading the dashboard from `chart/dashboards/competitive-intelligence.json`; the Grafana sidecar picks it up automatically.
