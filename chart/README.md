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
  - `serviceaccount.yaml` — thin `tenant-chart-base.serviceaccount` include; references the operator-owned `tenant-runtime` ServiceAccount (`serviceAccount.create: false`), which the operator binds to the tenant IAM role with a Pod Identity association. No role-arn annotation, no inline IAM.
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

## Substrate (declared)

Everything the pod needs is declared in `platform.yaml`, not a per-app component:

- The `main` `relational` datastore — Aurora Serverless v2 (PostgreSQL + pgvector at app bootstrap), the durable vector store that survives restarts so the first post-restart crawl diffs against real history instead of re-flooding alerts. Declared in `spec.datastores` and provisioned by the generic `tenant-substrate` component.
- The tenant IAM role — Bedrock `InvokeModel` for Claude Sonnet + Titan Embed v2 (operator model-scoping) plus the datastore-access policy the operator generates from `spec.datastores`. The operator owns it.
- Secrets Manager entries: `competitive-intelligence/<env>/app-secrets` (the Slack bot token for the alert sink + optional provider keys), seeded out of band, and the Aurora-managed `competitive-intelligence/<env>/db-credentials`.

## Pod identity

The chart's `serviceaccount.yaml` references the operator-owned `tenant-runtime` ServiceAccount (`serviceAccount.create: false`) and carries no role-arn annotation. The operator creates that ServiceAccount and binds `(namespace, tenant-runtime)` to the tenant IAM role through an EKS Pod Identity association, so EKS injects credentials into the pod through the standard AWS credential chain — no annotation, no role ARN in the chart, no API keys. Bedrock and every other AWS call resolve to this role on-cluster.

## LLM

Every model call goes through the Platform's ModelGateway, which authenticates to Bedrock via its EKS Pod Identity association with the tenant role. The chart names an endpoint and two route names; the models those routes resolve to are pinned on the `ModelGateway` CR in `platform.yaml` (`us.anthropic.claude-sonnet-5`, a cross-region inference profile — the current Claude family is profile-only, so a bare foundation-model id is rejected). Verify the profile exists in the target region before promoting, since cross-region profiles differ. Bedrock marks superseded models Legacy and starts refusing them with AccessDenied once an account has not called them for 30 days, so a pin left alone eventually breaks a deployment that never changed. There is no provider setting and no model key in this chart: reaching a model any other way would bypass the guardrail, the capture and the per-tenant attribution the gateway applies.

## Render locally

```sh
helm lint chart
helm template competitive-intelligence chart -f chart/values.yaml -f chart/values-production.yaml > rendered.yaml
```

`tenantInfra.pgHost` is empty at the chart level and the ServiceAccount carries no cloud identity, so a local render falls back to local-dev defaults — no real AWS resources required for a smoke render.

## Where the rest lives

This chart owns the app's k8s surface. The cloud substrate and cluster addons sit in other layers:

**Substrate (declared in `spec.datastores`, provisioned by `landing-zone`'s generic `tenant-substrate`):** the `main` Aurora Serverless v2 (pgvector) store. The operator owns the tenant IAM role and the Pod Identity association that binds `tenant-runtime` to it; the `main` datastore's endpoint feeds `tenantInfra.pgHost`. AWS Secrets Manager stays the source of truth; `externalsecret.yaml` syncs it into a k8s Secret via ESO.

**Cluster addons (`eks-gitops`):** the external-secrets operator + `aws-secrets-manager` ClusterSecretStore, the OpenTelemetry Collector gateway at `telemetry.monitoring.svc.cluster.local:4318` and the grafana-operator (→ Amazon Managed Grafana). The app writes structured JSON to stderr (tailed to Loki) and exports OTLP traces + metrics + logs to the collector gateway, which forwards traces → Tempo, metrics → AMP, logs → Loki. No per-pod sidecars.

**This chart:** the worker `Deployment`, the default-deny `networkpolicy.yaml`, the `externalsecret.yaml`, plus the observability that ships here rather than in eks-gitops:

- `prometheusrule.yaml` — crawl-failure, circuit-breaker-open, alert-send-failure, and pgvector-unreachable alert rules. **Nothing routes these on an EKS cluster, and the template is off by default there.** eks-gitops runs a managed metrics stack — the OpenTelemetry Collector receives OTLP and remote-writes to Amazon Managed Prometheus — with no kube-prometheus-stack and no Alertmanager, so no ruler evaluates a `PrometheusRule`. The CR still applies cleanly (`prometheus-operator-crds` is a bootstrap addon, so the kind exists), it is simply inert. Two places the rules do fire: the local `kx` cluster, which installs kube-prometheus-stack and has an in-cluster ruler — set `prometheusRule.enabled: true` there — and any other cluster running a Prometheus Operator. The production equivalent is a Grafana-managed alert rule evaluated by Amazon Managed Grafana against AMP, the same shape as `eks-gitops/dashboards/base/alerting/`.
- `grafana-dashboard.yaml` — a `GrafanaDashboard` CR loading the dashboard from `chart/dashboards/competitive-intelligence.json`; the grafana-operator reconciles it onto the external Amazon Managed Grafana.

> **Collector requirement (eks-gitops).** Metrics leave the pod as OTLP to the
> OpenTelemetry Collector (`telemetry.monitoring.svc.cluster.local:4318`), whose OTLP
> receiver hands them to a Prometheus exporter and a SigV4-signed `remote_write`
> into the cluster's Amazon Managed Service for Prometheus workspace. The
> `competitive_intelligence_*` series name needs nothing from the collector — the
> meter self-prefixes with the service namespace, and the OTLP→Prometheus
> translation supplies the `_total` / `_bucket` suffixes. The
> `deployment_environment` label the dashboard filters on is a different story:
> resource attributes only become metric labels when the collector's
> `otelcol.exporter.prometheus` sets `resource_to_telemetry_conversion` (off by
> default, in which case they land on `target_info` instead). If panels read
> empty, check that exporter config in `eks-gitops/addons/observability/otel-gateway`
> first. The pod also needs egress to the collector on tcp/4318
> (`networkPolicy.egress`, already included here).
