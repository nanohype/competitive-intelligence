# competitive-intelligence chart

Helm chart for the competitive-intelligence radar. Renders into a Platform tenant on the `eks-agent-platform` operator running on a nanohype-org EKS cluster.

The workload is a single long-lived process: a scheduler that runs one global crawl on an interval, the crawler that fetches competitor sites, the semantic-diff pipeline, an outbound Slack alert sink, and the MCP server (the pull/query surface). It serves two ports — the health port for probes and the MCP port. There is no public ingress: the MCP port is reachable only through the mcp-tunnel (outbound-only `cloudflared`), which the NetworkPolicy admits from the `mcp-tunnel` namespace alone.

## Files

- `Chart.yaml` — chart metadata + the `tenant-chart-base` dependency (see Dependencies)
- `values.yaml` — base values (all environments)
- `values-development.yaml` / `values-staging.yaml` / `values-production.yaml` — per-env deltas
- `charts/tenant-chart-base/` — vendored library subchart (see Dependencies)
- `dashboards/competitive-intelligence.json` — the Grafana dashboard JSON loaded by `grafana-dashboard.yaml`
- `templates/`
  - `deployment.yaml` — the pod. Non-root, `readOnlyRootFilesystem` with a `/tmp` emptyDir, env from `values.env` + `tenantInfra.pg*`, secrets via `envFrom: secretRef`, two containerPorts (`http` for `/health`+`/readyz`, `mcp` for the MCP server), liveness `/health` + readiness `/readyz` on the health port, `checksum/external-secret` pod-roll annotation. `replicaCount: 1` with a `Recreate` strategy — single-writer scheduler + crawl mutex, and the MCP `trigger_crawl` calls that same in-process mutex; never run two at once.
  - `service.yaml` — ClusterIP with two named ports: `http` (health, default 3000) and `mcp` (default 3001, the port the tunnel routes to)
  - `serviceaccount.yaml` — thin `tenant-chart-base.serviceaccount` include; name pinned to `competitive-intelligence`, bound to its IAM role by the landing-zone `competitive-intelligence-platform` Pod Identity association. No role-arn annotation, no inline IAM.
  - `externalsecret.yaml` — pulls the Slack bot token + optional provider keys from `competitive-intelligence/<env>/app-secrets` and `PGUSER`/`PGPASSWORD` from `competitive-intelligence/<env>/db-credentials`
  - `networkpolicy.yaml` — thin `tenant-chart-base.networkpolicy` include; default-deny + egress allow-list (DNS, HTTPS to the open internet minus IMDS, Postgres to the VPC CIDR). Ingress: same-namespace health probes, plus the MCP port from the `mcp-tunnel` namespace only (`namespaceSelector` on `kubernetes.io/metadata.name: mcp-tunnel`) — the tunnel is the single ingress to the MCP surface
  - `prometheusrule.yaml` — alerts (crawl-failure spike, circuit-breaker open, alert-send failure, pgvector unreachable); uses the base chart's fullname/labels helpers
  - `grafana-dashboard.yaml` — thin `tenant-chart-base` include rendering a `GrafanaDashboard` CR (instanceSelector `dashboards: external`) from `dashboards/competitive-intelligence.json`, reconciled by the grafana-operator onto Amazon Managed Grafana

## Dependencies

The chart vendors `charts/tenant-chart-base` — a `type: library` chart from
`nanohype/templates/tenant-chart-base`, declared in `Chart.yaml` as a
`file://charts/tenant-chart-base` dependency so `helm` works offline with no
fetch. It provides the shared named templates that render the ServiceAccount,
NetworkPolicy, PrometheusRule, and Grafana dashboard, plus the name/label
helpers (`tenant-chart-base.fullname`, `tenant-chart-base.labels`). There is no
local `_helpers.tpl`; those helpers live in the base subchart.

## Relationship to companion files

The chart alone is not enough to run the app. Two sibling files at the repo root complete the tenant trio:

- `../platform.yaml` — the cluster-scoped `Tenant` `strategy` plus the `BudgetPolicy` and `Platform` declaring this app as a tenant of the strategy team. The operator reconciles the `tenants-competitive-intelligence` Namespace, ResourceQuota, default-deny NetworkPolicy, ArgoCD AppProject, and the per-tenant IAM role from this CR. Apply once during initial setup.
- `../gitops/applicationset-entry.yaml` — ApplicationSet entry registered into `nanohype/eks-gitops`. ArgoCD picks up the entry and rolls out this chart per cluster/env.

## Required landing-zone component

Single-tenant component `components/aws/competitive-intelligence-platform/` provisions everything the pod needs:

- Aurora Serverless v2 (PostgreSQL + pgvector at app bootstrap) — the durable vector store that survives restarts, so the first post-restart crawl diffs against real history instead of re-flooding alerts
- IAM role with the inline policy: Bedrock `InvokeModel` for Claude Sonnet + Titan Embed v2, Secrets Manager read scoped to `competitive-intelligence/<env>/*`, CloudWatch `PutMetricData`
- Secrets Manager entries: `competitive-intelligence/<env>/app-secrets` (the Slack bot token for the alert sink + optional provider keys) and the Aurora-managed `competitive-intelligence/<env>/db-credentials`

## Pod identity

The chart's `serviceaccount.yaml` creates a ServiceAccount named `competitive-intelligence` (pinned via `serviceAccount.name`) and carries no role-arn annotation. The landing-zone `competitive-intelligence-platform` component creates an EKS Pod Identity association binding that `(namespace, service-account)` to the IAM role, so EKS injects credentials into the pod through the standard AWS credential chain — no annotation, no role ARN in the chart, no API keys. The ServiceAccount name must match the association's `service_account`, which is why it is pinned to the app name. Bedrock and every other AWS call resolve to this role on-cluster.

## LLM

Bedrock is the default LLM provider (`LLM_PROVIDER=bedrock`), authenticated via EKS Pod Identity. The model is pinned in `values.yaml` (`BEDROCK_LLM_MODEL: us.anthropic.claude-sonnet-4-20250514-v1:0`, a cross-region Sonnet inference profile — Converse requires the `us.anthropic.*-v1:0` profile form, not a bare alias) — verify the profile exists in the target region before promoting, since cross-region inference profiles differ. Anthropic and OpenAI remain pluggable alternates; their keys arrive through the ExternalSecret only when those providers are selected.

## Render locally

```sh
helm lint chart
helm template competitive-intelligence chart -f chart/values.yaml -f chart/values-production.yaml > rendered.yaml
```

`tenantInfra.pgHost` is empty at the chart level and the ServiceAccount carries no cloud identity, so a local render falls back to local-dev defaults — no real AWS resources required for a smoke render.

## Where the rest lives

This chart owns the app's k8s surface. The cloud substrate and cluster addons sit in other layers:

**Substrate (`landing-zone/components/aws/competitive-intelligence-platform/`):** Aurora Serverless v2 (pgvector), the IAM role, and the seeded Secrets Manager entries. It owns the IAM role and the Pod Identity association that binds the ServiceAccount to it; `aurora_cluster_endpoint` feeds `tenantInfra.pgHost`. AWS Secrets Manager stays the source of truth; `externalsecret.yaml` syncs it into a k8s Secret via ESO.

**Cluster addons (`eks-gitops`):** the external-secrets operator + `aws-secrets-manager` ClusterSecretStore, the Grafana Alloy OTLP receiver at `alloy.monitoring.svc.cluster.local:4318` and the grafana-operator (→ Amazon Managed Grafana). The app writes structured JSON to stderr (tailed to Loki) and exports OTLP traces + metrics + logs to Alloy, which forwards traces → Tempo, metrics → AMP, logs → Loki. No per-pod sidecars.

**This chart:** the worker `Deployment`, the default-deny `networkpolicy.yaml`, the `externalsecret.yaml`, plus the observability that ships here rather than in eks-gitops:

- `prometheusrule.yaml` — crawl-failure, circuit-breaker-open, alert-send-failure, and pgvector-unreachable alerts. Alertmanager (eks-gitops) routes them.
- `grafana-dashboard.yaml` — a `GrafanaDashboard` CR loading the dashboard from `chart/dashboards/competitive-intelligence.json`; the grafana-operator reconciles it onto the external Amazon Managed Grafana.

> **Collector requirement (eks-gitops).** Metrics leave the pod as OTLP to the
> Grafana Alloy collector (`alloy.monitoring.svc.cluster.local:4318`), whose OTLP
> receiver hands them to a Prometheus exporter and a SigV4-signed `remote_write`
> into the cluster's Amazon Managed Service for Prometheus workspace. The
> `competitive_intelligence_*` series name needs nothing from the collector — the
> meter self-prefixes with the service namespace, and the OTLP→Prometheus
> translation supplies the `_total` / `_bucket` suffixes. The
> `deployment_environment` label the dashboard filters on is a different story:
> resource attributes only become metric labels when Alloy's
> `otelcol.exporter.prometheus` sets `resource_to_telemetry_conversion` (off by
> default, in which case they land on `target_info` instead). If panels read
> empty, check that exporter config in `eks-gitops/addons/observability/alloy`
> first. The pod also needs egress to the collector on tcp/4318
> (`networkPolicy.egress`, already included here).
