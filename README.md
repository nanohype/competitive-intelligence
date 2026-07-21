# competitive-intelligence

![Build](https://github.com/nanohype/competitive-intelligence/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/License-Apache--2.0-green)
![Node](https://img.shields.io/badge/Node-%3E%3D24-339933?logo=node.js)
![Kubernetes](https://img.shields.io/badge/Kubernetes-Tenant-326CE5?logo=kubernetes)

A competitive-intelligence radar. It crawls competitor websites on an interval, embeds the content, and **semantic-diffs** each page against its own history using embedding cosine similarity — not text comparison — so only meaningfully new content counts as a change. When a page's change score clears the significance threshold, an LLM analyzes the new content (summary + significance + extracted signals) and fires a Slack alert. The accumulated intelligence is queryable through an MCP server (the tools any Claude surface calls) and the CLI.

**AI clients / agents start here:** [`AGENTS.md`](AGENTS.md). For the stack-wide view, see the [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md).

> The default alert channel is `#competitive-intel` (a short handle the team watches).

## What it is

A radar that watches competitor marketing, docs, and pricing pages and tells you when something actually changed. The trick is the diff: each page is chunked and embedded, and a chunk only counts as "new" when its cosine similarity to the best stored match for that source falls below 0.85. A reworded paragraph or a reordered nav doesn't fire; a new enterprise tier or a deprecated API does. Above-threshold changes get an LLM analysis and a Slack alert; the accumulated history answers ad-hoc questions through the MCP `search_intel` tool (or `npm run query`).

Two halves: an autonomous **push radar** (scheduler → crawl → semantic-diff → alert) and an interactive **pull surface** — an MCP server whose tools Claude surfaces call. The radar posts through an outbound Slack sink; the query surface is the MCP server.

History is durable — embeddings live in pgvector (Aurora), so a pod restart or rollout diffs the next crawl against real history instead of re-flagging every page as new. A cold-start guard backs that up: the first crawl of any unseeded source is treated as baseline seeding (ingest + embed, no alerts). Bedrock (Claude Sonnet via Converse for analysis, Titan v2 for embeddings) is the default and runs on-account via EKS Pod Identity — no keys; Anthropic and OpenAI are pluggable alternates. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the bounded contexts, the crawl→alert data flow, and the load-bearing decisions.

![architecture](docs/architecture.svg)

## Quickstart

```bash
npm install
cp .env.example .env             # fill in values — see CLAUDE.md > Configuration
cp sources.example.json sources.json
npm run dev                      # tsx watch src/index.ts — scheduler + alert sink + MCP server + /health
```

`npm run dev` serves `/health` + `/readyz` on `:3000` (PORT) and the MCP server on `:3001` (MCP_PORT). Local dev defaults to `VECTOR_PROVIDER=memory` (no database). To exercise durable history, point `VECTOR_PROVIDER=pgvector` + `DATABASE_URL` at a Postgres with the `vector` extension. From the CLI:

```bash
npm run crawl                    # one-off crawl + diff + alert
npm run query -- "Who launched new AI features?"
```

Run the full local gate before pushing:

```bash
task ci   # build + lint + typecheck + format:check + test + helm lint/template + docker build
```

## Bedrock prerequisites

Bedrock is the default for both LLM and embeddings and runs on the AWS credential chain — no API keys. On the cluster that chain resolves to the pod's IAM role via EKS Pod Identity; locally it resolves to your `~/.aws` credentials or SSO. Confirm `aws sts get-caller-identity` works, and enable model access for the configured `BEDROCK_LLM_MODEL` (default `us.anthropic.claude-sonnet-4-20250514-v1:0`) and `amazon.titan-embed-text-v2:0` in the [Bedrock console](https://console.aws.amazon.com/bedrock/home#/modelaccess) for your region. To use a direct API provider instead, set `LLM_PROVIDER` / `EMBEDDING_PROVIDER` and the matching key.

## Sources

Monitored pages live in `sources.json` (validated with Zod on load; `sources.example.json` is a starter set of AI-SaaS competitor pages). Each entry:

```json
{
  "competitor": "aws",
  "url": "https://aws.amazon.com/new/",
  "type": "changelog",
  "selectors": { "content": "main", "exclude": ["nav", "footer", "#aws-page-header"] }
}
```

`type` is one of `changelog` / `blog` / `pricing` / `careers` / `docs` / `general`. `selectors.content` scopes the main content region (defaults to `body`); `selectors.exclude` strips nav/footer/ads. The per-source history key is `id`, which defaults to `<competitor>:<type>` — set it explicitly to monitor two same-type pages for one competitor. The fetcher is static HTML; JS-rendered SPAs return little content. Selectors track each site's markup, so a competitor redesign may need an update.

## Query surface (MCP)

The pull surface is an MCP server (streamable HTTP, `@modelcontextprotocol/sdk`) on `MCP_PORT`. Any Claude surface — claude.ai, Desktop, Claude Code, mobile — consumes it as a custom connector; the model does the reasoning over what the tools return. On the cluster the mcp-tunnel (outbound-only) is its only ingress; locally it's reachable at `http://localhost:3001/mcp`.

| Tool                                         | Returns                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `search_intel(question, competitor?, topK?)` | The ranked chunks + source metadata for the question (retrieved context, not a composed answer) |
| `trigger_crawl()`                            | Runs a crawl through the single-writer mutex; `ran` or `skipped`                                |
| `status()`                                   | Uptime, heap usage, Node version                                                                |
| `list_sources()`                             | The configured crawl sources (id / competitor / url / type)                                     |

`search_intel` returns retrieved evidence; the consuming model composes the answer. The CLI (`npm run query`) is the on-account composed-answer path over the same retrieval.

## Alerts (Slack)

Alerts are outbound only. The radar posts its deterministic Block Kit alerts to `#competitive-intel` via `@slack/web-api` `chat.postMessage`. Set `SLACK_BOT_TOKEN` (a bot token with `chat:write`) and optionally `SLACK_ALERT_CHANNEL`. Absent a token, alerts log to stderr — the CLI and MCP surface work without Slack.

## Deploy

Ships as a [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) Platform tenant. The trio:

- **`chart/`** — the application Helm chart: Deployment (`replicaCount: 1`, single-writer crawl mutex) + Service (the `/health`+`/readyz` port and the MCP port) + NetworkPolicy (default-deny + egress allow-list, IMDS blocked; ingress only same-namespace probes and the MCP port from the `mcp-tunnel` namespace) + ServiceAccount (Pod Identity) + ExternalSecret (ESO), plus PrometheusRule alerts and a Grafana dashboard. Per-env deltas in `chart/values-{development,staging,production}.yaml`.
- **`platform.yaml`** — the `Platform` CR + `BudgetPolicy` declaring the tenant boundary: `tenant: strategy` (the owning team), authored in the team's `tenants-strategy` control-plane namespace. From it the operator reconciles the workload namespace `tenants-competitive-intelligence`, its ResourceQuota and NetworkPolicy, and the ArgoCD AppProject `competitive-intelligence` — all named after the Platform, not the team.
- **`gitops/applicationset-entry.yaml`** — the ApplicationSet entry registered into [`nanohype/eks-gitops`](https://github.com/nanohype/eks-gitops) for ArgoCD reconciliation.

The AWS substrate — Aurora Serverless v2 (pgvector), the IAM role, and Secrets Manager seeding — is provisioned by the `competitive-intelligence-platform` component in [`landing-zone`](https://github.com/nanohype/landing-zone). It binds the role to the chart's ServiceAccount with an EKS Pod Identity association; the Aurora endpoint feeds `tenantInfra.*`. Apply `platform.yaml` once, wait for `Ready`, then ArgoCD owns the rollout: bump `image.tag` in the per-env values, commit, push.

## Boundaries

This repo owns the application — the crawler, the semantic-diff pipeline, the alert + intel engines, the MCP query surface, the outbound alert sink, and the tenant trio that deploys it. It does **not** own:

- AWS substrate (Aurora/pgvector, the IAM role, Secrets Manager seeding) → the `competitive-intelligence-platform` component in [`landing-zone`](https://github.com/nanohype/landing-zone)
- Cluster addons (external-secrets, the OTel collector + log forwarder, kube-prometheus-stack, the mcp-tunnel that fronts the MCP surface) → [`eks-gitops`](https://github.com/nanohype/eks-gitops)

## Configuration

All config via env vars, validated by Zod in `src/config.ts` — see [`CLAUDE.md`](CLAUDE.md) § Configuration for the full inventory. In-cluster, secret values come from AWS Secrets Manager (`competitive-intelligence/<env>/*`) via the chart's ExternalSecret; `.env.example` is for local dev only.

## License

Apache-2.0.
