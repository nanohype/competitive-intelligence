# competitive-intelligence — agent entry point

You're an AI client (or the author of one) about to run this service locally, call its MCP tools, add a crawl source, wire a new LLM or embedding provider, swap the vector backend, or ship it as a Platform tenant. This file gets you running in five minutes. For the wider picture — how this repo fits into the nanohype stack — read the [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md).

> The repo, product name, npm package, OTel `service.name` / `agents.platform`, image repo, and `competitive-intelligence/<env>/*` secret prefixes are all the literal name. The default alert channel is `#competitive-intel` — a short handle users watch.

## What this repo gives you

A competitive-intelligence radar with two halves. The **push radar** crawls competitor marketing/docs/pricing pages on an interval, embeds the content, and **semantic-diffs** each page against the last crawl using embedding cosine similarity — not text comparison. Only semantically novel content counts as a change. When a page's change score clears the significance threshold, an LLM analyzes the new content (summary + significance + extracted signals) and fires a Slack alert to `#competitive-intel` through an outbound sink. The **pull surface** is an MCP server: its tools (`search_intel`, `trigger_crawl`, `status`, `list_sources`) let any Claude surface query the accumulated intelligence and drive the radar. `search_intel` returns the retrieved context (ranked chunks + source metadata) — the consuming model reasons over it. The same intelligence is queryable from the CLI.

## MCP tools

The MCP server (streamable HTTP, `@modelcontextprotocol/sdk`, `src/mcp/`) runs on `MCP_PORT` (default 3001, path `/mcp`). Register it as a custom connector in a Claude surface; on the cluster it's fronted by the mcp-tunnel.

| Tool            | Input                                                                 | Returns                                                                    |
| --------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `search_intel`  | `question`, optional `competitor`, optional `topK` (1–50, default 10) | Ranked chunks + source metadata (retrieved context, not a composed answer) |
| `trigger_crawl` | —                                                                     | `ran` / `skipped` (through the single-writer crawl mutex)                  |
| `status`        | —                                                                     | Uptime, heap usage, Node version                                           |
| `list_sources`  | —                                                                     | Configured sources (id / competitor / url / type)                          |

Every tool input is Zod-validated at the boundary (`src/mcp/tools.ts`); a bad argument returns an `isError` tool result, an unknown tool a protocol error. To add a tool: add its descriptor to `listTools`, a Zod schema, and a `dispatchTool` case, then a test through the pure `callTool` dispatcher — don't mock the SDK.

The load-bearing property is that **history is durable**. Embeddings live in pgvector (Aurora), so a pod restart, rollout, or node drain diffs the next crawl against real history instead of re-flagging every page as new. A cold-start guard backs that up: the first crawl of any source whose stored vector count is zero is treated as baseline seeding (ingest + embed, no alerts), so a genuine first deploy or an empty backend doesn't flood the channel.

It's built around a provider-registry seam. LLM, embeddings, and vector store are each a `createRegistry<T>()` of named implementations selected by config; `src/index.ts` is the one place real SDK clients are constructed and wired. Bedrock is the default for both LLM (Converse) and embeddings (Titan) — on the cluster the AWS credential chain resolves to the pod's IAM role via EKS Pod Identity, so there are no keys. Anthropic and OpenAI stay as pluggable alternates.

## Run it in five minutes

```bash
npm install
cp .env.example .env       # fill in the keys you need (see CLAUDE.md > Configuration)
cp sources.example.json sources.json
npm run dev                # tsx watch src/index.ts — scheduler + alert sink + MCP server + /health
```

`npm run dev` serves `/health` + `/readyz` on `:3000` (PORT) and the MCP server on `:3001` (MCP_PORT, path `/mcp`). Local dev defaults to `VECTOR_PROVIDER=memory` (no database needed). Point `VECTOR_PROVIDER=pgvector` + `DATABASE_URL` at a Postgres with the `vector` extension to exercise durable history. Point a Claude surface at `http://localhost:3001/mcp` and call `search_intel("what changed at <competitor> this week?")`.

```bash
task ci                    # build + lint + typecheck + format:check + test + helm + docker (CI parity)
```

CLI without Slack:

```bash
npm run crawl              # one-off crawl + diff + alert
npm run query -- "question"
```

## Contract surface

Shipping this on a cluster means three artifacts travel together: the **Platform CR**, the **Helm chart**, and the **gitops entry**. They're the tenant contract.

### The Platform CR (`platform.yaml`)

Three CRs — a cluster-scoped `Tenant` (`platform.nanohype.dev/v1alpha1`) for the owning team, a `BudgetPolicy` (`governance.nanohype.dev/v1alpha1`), and the `Platform` (`platform.nanohype.dev/v1alpha1`) that references both:

```yaml
apiVersion: platform.nanohype.dev/v1alpha1
kind: Tenant
metadata:
  name: strategy
spec:
  displayName: Strategy
  primaryPersona: marketing
  aggregateMonthlyBudgetUsd: '2500'
  compliance: { soc2: true, hipaa: false }
---
apiVersion: governance.nanohype.dev/v1alpha1
kind: BudgetPolicy
metadata:
  name: competitive-intelligence
  namespace: tenants-strategy
spec:
  platformRef: { name: competitive-intelligence }
  monthlyUsd: '2500' # kill-switch fires at 120% (USD 3000)
  alertThresholdsPercent: [50, 80, 100]
  killSwitchEnabled: true
---
apiVersion: platform.nanohype.dev/v1alpha1
kind: Platform
metadata:
  name: competitive-intelligence
  namespace: tenants-strategy
spec:
  displayName: competitive-intelligence
  persona: marketing
  tenant: strategy
  budget: { name: competitive-intelligence }
  identity:
    allowedModels: # Claude Sonnet (diff analysis) + Titan (chunk embeddings)
      - us.anthropic.claude-sonnet-4-20250514-v1:0
      - us.anthropic.claude-sonnet-4-6
      - amazon.titan-embed-text-v2:0
    extraPolicyArns: [] # filled per env with the landing-zone app-access policy
  compliance: { soc2: true }
  isolation: namespace
```

The `Tenant` is cluster-scoped — it is the strategy team as an organizational boundary, and `Platform.spec.tenant` references it by name. The `BudgetPolicy` and `Platform` live in `tenants-strategy`, the strategy team's control-plane namespace. From `Platform.metadata.name` the operator reconciles the workload namespace `tenants-competitive-intelligence`, its ResourceQuota, LimitRange, default-deny NetworkPolicy, the ArgoCD AppProject `competitive-intelligence`, and the `<env>-competitive-intelligence-tenant` IAM role with Bedrock invoke clamped to `spec.identity.allowedModels`. App pods and AgentFleet pods share that one role — the chart's ServiceAccount binds to it through the EKS Pod Identity association the landing-zone `competitive-intelligence-platform` component creates (no role-arn annotation), and the app's substrate grants reach it as an `extraPolicyArns` entry filled per environment at apply time.

Two tokens, two scopes: `spec.tenant` is the owning team (`strategy`) and drives labels, tags, and OTel attributes; `metadata.name` is the app (`competitive-intelligence`) and drives the workload namespace, the AppProject, and the tenant IAM role name.

### The Helm chart (`chart/`)

The application Deployment plus everything that supports it. Templates under `chart/templates/`:

| Template                 | Owns                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment.yaml`        | The main pod — scheduler + crawler + outbound alert sink + MCP server + HTTP health server, one process. `replicaCount: 1` (single-writer crawl mutex)                                                                              |
| `service.yaml`           | ClusterIP with two ports — the health port (`/health` + `/readyz`) and the MCP port the mcp-tunnel routes to                                                                                                                        |
| `serviceaccount.yaml`    | name pinned to the app; bound to the `<env>-competitive-intelligence-tenant` IAM role by an EKS Pod Identity association. No role-arn annotation, no inline IAM                                                                     |
| `externalsecret.yaml`    | ESO syncs `competitive-intelligence/<env>/app-secrets` (Slack bot token + optional provider keys) + `competitive-intelligence/<env>/db-credentials` (PG creds) from Secrets Manager                                                 |
| `networkpolicy.yaml`     | Default-deny + egress allow-list (DNS, HTTPS to crawl targets + Bedrock + Slack with IMDS blocked, Postgres on the VPC CIDR). Ingress: same-namespace probes + the MCP port from the `mcp-tunnel` namespace only. No public ingress |
| `prometheusrule.yaml`    | Alert rules — crawl failures, circuit-breaker open, alert-send failures, pgvector unreachable. Off by default: they need a Prometheus Operator ruler, which eks-gitops (Alloy → AMP) does not run. Enable on `kx`                    |
| `grafana-dashboard.yaml` | `GrafanaDashboard` CR loading `chart/dashboards/competitive-intelligence.json`; the grafana-operator reconciles it onto Amazon Managed Grafana                                                                                       |

`values.yaml` is the base; `values-development.yaml` / `values-staging.yaml` / `values-production.yaml` carry the per-env deltas (image tag, `tenantInfra.*` PG host/port/db). The image is `ghcr.io/nanohype/competitive-intelligence`. OTel attrs `agents.tenant=strategy` + `agents.platform=competitive-intelligence` are set in every values file (required by the platform-tenant contract). There's **no public ingress**: the MCP surface is reached only through the mcp-tunnel (outbound-only `cloudflared`), which the NetworkPolicy admits from the `mcp-tunnel` namespace alone; the only other inbound is same-namespace health probes. Wiring the tunnel addon + the per-tenant route is `eks-gitops` + operator work — this repo just ships a tunnel-ready Service locked by NetworkPolicy.

### Required tenant files

A valid tenant in this repo is exactly these three, plus the chart's per-env values:

- `platform.yaml` — the cluster-scoped `Tenant` + the `BudgetPolicy` + `Platform` CRs
- `chart/` — the chart above, with `values.yaml` + `values-{development,staging,production}.yaml`
- `gitops/applicationset-entry.yaml` — the ApplicationSet entry registered into `nanohype/eks-gitops` (matrix generator over clusters × the app, Helm multi-source `$values` resolving `values.yaml` + `values-<env>.yaml`)

`npm run platform:validate` (CI job **Platform Manifest Validation**, and `task platform:validate` locally) checks `platform.yaml` before a cluster ever sees it. It walks every document against the real operator CRD schemas vendored under `schemas/crd/` — copied from `nanohype/eks-agent-platform` at the SHA pinned in `schemas/crd/source.json`, so the gate is deterministic and adopting a newer operator API is an explicit commit. Four things it catches that `kubectl apply --dry-run=client` does not:

- **A schema that is not the generated one.** Every file in `schemas/crd/` is hashed against the SHA-256 recorded for it in `source.json` before it is parsed, and undeclared YAML in that directory is an error. Widening an enum in a vendored copy so the manifest under review slips through fails the run — no network needed, so the property holds on a laptop as well as in CI. `schemas:check` closes the other side: it compares the copies to the operator repo at the pinned SHA, so a tamper that also rewrote the digest, or a pin that no longer matches the committed schemas, fails there.
- **Unknown fields.** controller-gen emits no `additionalProperties: false`, so `allowedModls:` passes a stock JSON-schema validator and is then silently pruned by the apiserver — leaving a Platform whose IAM role grants no Bedrock access at all. The walker treats any property absent from `properties` as an error unless the schema opts into open content.
- **Scope.** `Tenant` is cluster-scoped and must carry no `metadata.namespace`; `Platform` and `BudgetPolicy` must carry one. Scope is read from each CRD's own `spec.scope`.
- **Cross-references.** `Platform.spec.tenant` == the `Tenant`'s name, the budget references round-trip, `allowedModels` and `allowedModelFamilies` stay mutually exclusive (the CRD's CEL rule, asserted here because CEL is not evaluated), and `agents.tenant` / `agents.platform` in every chart values file match both. A rename that lands in one file and not the others fails here rather than in a half-reconciled namespace.

If the vendored schemas are missing, altered, or unparseable the gate exits non-zero and says so. It never passes for want of a schema, and never trusts one it cannot verify.

`node scripts/validate-platform-manifests.mjs --self-test` (the second half of `npm run platform:validate`) breaks the inputs in memory seven ways — a tampered schema, an unknown field, a missing required field, a dangling tenant reference, a namespaced cluster-scoped CR, both model-allow-lists at once, a drifted chart attribute — and fails unless each is rejected. It writes nothing, and it keeps "the gate rejects" a tested property rather than a claim in a comment.

## Add a crawl source

Sources are data, not code — they live in `sources.json` (validated with Zod on load against the schema in `src/crawler/sources.ts`; see `sources.example.json` for the shape and a starter set of AI-SaaS competitor pages).

1. Add an entry: `{ competitor, url, type, selectors? }`. `type` is one of `changelog` / `blog` / `pricing` / `careers` / `docs` / `general`. `selectors.content` is the CSS selector for the main content region (defaults to `body`) and `selectors.exclude` is a list of selectors to strip (nav/footer/ads) before HTML→text extraction. The stable per-source key the differ groups history on is `id` — it defaults to `<competitor>:<type>`; set it explicitly if you monitor two pages of the same type for one competitor (changing it resets that source's history).
2. That's it — no redeploy logic. The next crawl picks it up. Its **first crawl is treated as a baseline** by the cold-start guard (ingest + embed, no alert), so adding a source never produces a one-time flood.

## Add an LLM or embedding provider

LLM and embeddings each go through a self-registering registry (`createRegistry<T>()`, vendored from `@nanohype/runtime` at `src/vendor/runtime/registry.ts`). Built-ins: LLM = Bedrock (default) / Anthropic / OpenAI; embeddings = Bedrock Titan (default) / OpenAI. To add one:

1. **Implement the interface** — write a class implementing `LlmProvider` (`chat(system, userMessage)`) in `src/providers/llm.ts` or `EmbeddingProvider` (`embed(texts)`) in `src/providers/embeddings.ts`. Wrap the external call in a `createBreaker` circuit breaker (mirror the existing `failureThreshold: 3` per-provider breakers).
2. **Register it in the bootstrap** — add a `registry.register("<name>", () => new YourProvider(...))` line in `bootstrapLlm` / `bootstrapEmbeddings`. Gate it on the credential it needs (the Anthropic/OpenAI registrations only happen when their key is present).
3. **Widen the config enum** — add `<name>` to the `llmProvider` / `embeddingProvider` Zod enum in `src/config.ts` and document the env var in `.env.example`.
4. **Keep Bedrock the default.** New non-Anthropic LLM providers stay opt-in — `bedrock` is the default and the LLM policy forbids defaulting to a non-Anthropic model.
5. **Test it** — implement the interface against a fake; don't mock SDK internals. See `src/providers/vectors.test.ts` for the pattern.

## Add a vector backend

The vector store is the durability seam. `VectorStore` (`src/providers/vectors.ts`) is a narrow interface — `upsert` / `search` / `delete` / `deleteByMetadata` / `count`. Two implementations ship: `MemoryVectorStore` (local dev / tests, lost on restart) and `PgVectorStore` (durable, the production default — `vector(N)` column + cosine-distance index, `CREATE EXTENSION IF NOT EXISTS vector` + table DDL at bootstrap). To add a third (OpenSearch / Qdrant / Pinecone / …):

1. **Implement `VectorStore`** — `search` must return cosine-similarity-scored hits (the differ's 0.85 threshold and the cold-start `count()` guard both depend on the contract). Filter on the `sourceId` metadata key — the differ searches per-source.
2. **Register it** — add a `vectorRegistry.register("<name>", () => new YourStore(...))` line in `bootstrapVectorStore` and widen the `vectorProvider` Zod enum in `src/config.ts`.
3. **Honor the cold-start contract** — a fresh backend must report `count() === 0` for an unseeded source so the pipeline's baseline guard suppresses the first-crawl alert storm.
4. **Test it** — implement the interface against an in-process fake or a containerized backend; don't mock the driver. See `src/providers/vectors.test.ts`.

## Conventions

- **Provider registry, not inline construction.** LLM / embeddings / vectors are each a `createRegistry<T>(kind)` returning typed `{ register, get, has, names }`. Pick the implementation by config; `src/index.ts` is the only place real clients are built. Swapping a backend is a one-file change to the bootstrap.
- **Bedrock-default LLM.** Bedrock (Converse for the LLM, Titan for embeddings) is the default and runs on the AWS credential chain — EKS Pod Identity on the cluster, no keys. Anthropic/OpenAI are alternates that only register when their key is present.
- **Prompt caching.** The analysis system prompt is identical on every diff, so the Converse request marks a `cachePoint` after the system block. Cache hits are emitted as a metric — see `ARCHITECTURE.md` § Prompt caching.
- **Circuit breakers on every external call** — per-host for the crawler's HTTP fetcher, per-provider for LLM + embeddings, and around the Slack alert sink. Sliding-window semantics (trips on failure density within a rolling window, single half-open probe after the cooldown), vendored from `@nanohype/runtime` and wired through `src/resilience/`.
- **Vendored runtime modules stay byte-identical.** `src/vendor/runtime/` is a copy of `nanohype/library/runtime` modules — never edit locally. Fix upstream (with tests), then `npm run sync:vendored`; CI's drift check fails on any divergence, exactly like the vendored `tenant-chart-base` chart.
- **Single-writer scheduler + crawl mutex.** `replicaCount: 1`. The scheduler, alert sink, and MCP server share one process; the scheduler runs one global crawl over all sources on an interval, and an in-process mutex prevents the scheduler and an MCP `trigger_crawl` from overlapping. Scaling horizontally without leader election would double-crawl and race the differ — don't.
- **SSRF-guarded crawling.** Every outbound crawl URL passes `guardUrl` (`src/crawler/url-guard.ts`) — rejects loopback, RFC1918, link-local, and cloud-metadata addresses before the fetch.
- TypeScript strict, ESM NodeNext, Node ≥ 24. Zod at every boundary (config, sources, log level, LLM analysis output). Structured JSON logging to stderr via a hand-rolled logger (`src/logger.ts`); stdout is reserved for CLI output. Explicit timeouts on every external call (Bedrock/Anthropic/OpenAI, pgvector, Slack).

## Pointers

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — bounded contexts, the crawl→alert data flow, load-bearing decisions, prompt-cache measurement, and where the boundaries sit (landing-zone substrate, eks-gitops addons)
- [`CLAUDE.md`](CLAUDE.md) — per-module breakdown, configuration, conventions, test map
- [`README.md`](README.md) — front door: run, test, deploy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the crawl-source / provider / vector-backend recipes + the test contract + PR flow
- [`SECURITY.md`](SECURITY.md) — reporting, posture (SSRF guard, Pod-Identity-only, default-deny network), known limitations
- [`chart/README.md`](chart/README.md) — template-by-template chart reference + the per-tenant infra it expects
- [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md) — the stack-wide view
- [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) — the operator that reconciles the Platform CR
- [`landing-zone`](https://github.com/nanohype/landing-zone) — the `competitive-intelligence-platform` substrate (Aurora pgvector + IAM + Secrets Manager) the chart's IAM role and data store live in
