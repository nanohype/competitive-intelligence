# competitive-intelligence — agent entry point

You're an AI client (or the author of one) about to run this service locally, add a crawl source, wire a new LLM or embedding provider, swap the vector backend, or ship it as a Platform tenant. This file gets you running in five minutes. For the wider picture — how this repo fits into the nanohype stack — read the [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md).

> The repo, product name, npm package, OTel `service.name` / `agents.platform`, image repo, `competitive-intelligence/<env>/*` secret prefixes, and the Slack slash command (`/competitive-intelligence`) are all the literal name. The default alert channel is `#competitive-intel` — a short handle users watch.

## What this repo gives you

A competitive-intelligence radar. It crawls competitor marketing/docs/pricing pages on an interval, embeds the content, and **semantic-diffs** each page against the last crawl using embedding cosine similarity — not text comparison. Only semantically novel content counts as a change. When a page's change score clears the significance threshold, an LLM analyzes the new content (summary + significance + extracted signals) and fires a Slack alert to `#competitive-intel`. You can also query the accumulated intelligence over Slack (`/competitive-intelligence query …`) or the CLI.

The load-bearing property is that **history is durable**. Embeddings live in pgvector (Aurora), so a pod restart, rollout, or node drain diffs the next crawl against real history instead of re-flagging every page as new. A cold-start guard backs that up: the first crawl of any source whose stored vector count is zero is treated as baseline seeding (ingest + embed, no alerts), so a genuine first deploy or an empty backend doesn't flood the channel.

It's built around a provider-registry seam. LLM, embeddings, and vector store are each a `createRegistry<T>()` of named implementations selected by config; `src/index.ts` is the one place real SDK clients are constructed and wired. Bedrock is the default for both LLM (Converse) and embeddings (Titan) — on the cluster the AWS credential chain resolves to IRSA, so there are no keys. Anthropic and OpenAI stay as pluggable alternates.

## Run it in five minutes

```bash
npm install
cp .env.example .env       # fill in the keys you need (see CLAUDE.md > Configuration)
cp sources.example.json sources.json
npm run dev                # tsx watch src/index.ts — scheduler + Slack bot + /health on :3000
```

Local dev defaults to `VECTOR_PROVIDER=memory` (no database needed). Point `VECTOR_PROVIDER=pgvector` + `DATABASE_URL` at a Postgres with the `vector` extension to exercise durable history. In Slack: `/competitive-intelligence query what changed at <competitor> this week?`

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

Two CRs in different groups — a `BudgetPolicy` (`governance.nanohype.dev/v1alpha1`) and the `Platform` (`platform.nanohype.dev/v1alpha1`) that references it:

```yaml
apiVersion: governance.nanohype.dev/v1alpha1
kind: BudgetPolicy
metadata:
  name: competitive-intelligence
  namespace: tenants-protohype
spec:
  platformRef: { name: competitive-intelligence }
  monthlyUsd: "2500" # kill-switch fires at 120%
  alertThresholdsPercent: [50, 80, 100]
  killSwitchEnabled: true
---
apiVersion: platform.nanohype.dev/v1alpha1
kind: Platform
metadata:
  name: competitive-intelligence
  namespace: tenants-protohype
spec:
  displayName: competitive-intelligence
  persona: marketing
  tenant: protohype
  budget: { name: competitive-intelligence }
  identity:
    allowedModelFamilies: [anthropic, amazon] # Claude (LLM) + Titan (embeddings)
    extraPolicyArns: [] # app pods assume the landing-zone role directly
  compliance: { soc2: true }
  isolation: namespace
```

The operator reconciles the namespace `tenants-protohype`, ResourceQuota, LimitRange, default-deny NetworkPolicy, and ArgoCD AppProject. **The app pods assume the landing-zone `competitive-intelligence-platform` IRSA role directly** via the chart's `aws.platformRoleArn` Helm value — that's why `extraPolicyArns` stays empty. The tenant boundary (`tenant: protohype`, namespace `tenants-protohype`, project `tenant-protohype`) does not change with the repo name.

### The Helm chart (`chart/`)

The application Deployment plus everything that supports it. Templates under `chart/templates/`:

| Template                 | Owns                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deployment.yaml`        | The main pod — scheduler + Slack bot + HTTP health server on the health port. `replicaCount: 1` (single-writer crawl mutex)                                               |
| `service.yaml`           | ClusterIP on the health port (`/health` + `/readyz`)                                                                                                                      |
| `serviceaccount.yaml`    | `eks.amazonaws.com/role-arn` rendered from `aws.platformRoleArn` (the landing-zone role). No inline IAM                                                                   |
| `externalsecret.yaml`    | ESO syncs `competitive-intelligence/<env>/app-secrets` (Slack + optional provider keys) + `competitive-intelligence/<env>/db-credentials` (PG creds) from Secrets Manager |
| `networkpolicy.yaml`     | Default-deny + egress allow-list (DNS, HTTPS to crawl targets + Bedrock + Slack with IMDS blocked, Postgres on the VPC CIDR). No public ingress                           |
| `prometheusrule.yaml`    | Alerts — crawl failures, circuit-breaker open, alert-send failures, pgvector unreachable                                                                                  |
| `grafana-dashboard.yaml` | ConfigMap loading `chart/dashboards/competitive-intelligence.json`                                                                                                        |

`values.yaml` is the base; `values-dev.yaml` / `values-staging.yaml` / `values-production.yaml` carry the per-env deltas (image tag, `aws.platformRoleArn`, `tenantInfra.*` PG host/port/db). The image is `ghcr.io/nanohype/competitive-intelligence`. OTel attrs `agents.tenant=protohype` + `agents.platform=competitive-intelligence` are set in every values file (required by the platform-tenant contract). There's **no ingress** — the Slack surface is Socket Mode (outbound), and the only inbound is same-namespace probes.

### Required tenant files

A valid tenant in this repo is exactly these three, plus the chart's per-env values:

- `platform.yaml` — the `BudgetPolicy` + `Platform` CRs
- `chart/` — the chart above, with `values.yaml` + `values-{dev,staging,production}.yaml`
- `gitops/applicationset-entry.yaml` — the ApplicationSet entry registered into `nanohype/eks-gitops` (matrix generator over clusters × the app, Helm multi-source `$values` resolving `values.yaml` + `values-<env>.yaml`)

## Add a crawl source

Sources are data, not code — they live in `sources.json` (validated with Zod on load against the schema in `src/crawler/sources.ts`; see `sources.example.json` for the shape and a starter set of AI-SaaS competitor pages).

1. Add an entry: `{ competitor, url, type, selectors? }`. `type` is one of `changelog` / `blog` / `pricing` / `careers` / `docs` / `general`. `selectors.content` is the CSS selector for the main content region (defaults to `body`) and `selectors.exclude` is a list of selectors to strip (nav/footer/ads) before HTML→text extraction. The stable per-source key the differ groups history on is `id` — it defaults to `<competitor>:<type>`; set it explicitly if you monitor two pages of the same type for one competitor (changing it resets that source's history).
2. That's it — no redeploy logic. The next crawl picks it up. Its **first crawl is treated as a baseline** by the cold-start guard (ingest + embed, no alert), so adding a source never produces a one-time flood.

## Add an LLM or embedding provider

LLM and embeddings each go through a self-registering registry (`createRegistry<T>()` in `src/providers/registry.ts`). Built-ins: LLM = Bedrock (default) / Anthropic / OpenAI; embeddings = Bedrock Titan (default) / OpenAI. To add one:

1. **Implement the interface** — write a class implementing `LlmProvider` (`chat(system, userMessage)`) in `src/providers/llm.ts` or `EmbeddingProvider` (`embed(texts)`) in `src/providers/embeddings.ts`. Wrap the external call in a `CircuitBreaker` (mirror the existing `failureThreshold: 3` per-provider breakers).
2. **Register it in the bootstrap** — add a `registry.register("<name>", () => new YourProvider(...))` line in `bootstrapLlm` / `bootstrapEmbeddings`. Gate it on the credential it needs (the Anthropic/OpenAI registrations only happen when their key is present).
3. **Widen the config enum** — add `<name>` to the `llmProvider` / `embeddingProvider` Zod enum in `src/config.ts` and document the env var in `.env.example`.
4. **Keep Bedrock the default.** New non-Anthropic LLM providers stay opt-in — `bedrock` is the default and the LLM policy forbids defaulting to a non-Anthropic model.
5. **Test it** — implement the interface against a fake; don't mock SDK internals. See `src/providers/registry.test.ts` for the pattern.

## Add a vector backend

The vector store is the durability seam. `VectorStore` (`src/providers/vectors.ts`) is a narrow interface — `upsert` / `search` / `delete` / `deleteByMetadata` / `count`. Two implementations ship: `MemoryVectorStore` (local dev / tests, lost on restart) and `PgVectorStore` (durable, the production default — `vector(N)` column + cosine-distance index, `CREATE EXTENSION IF NOT EXISTS vector` + table DDL at bootstrap). To add a third (OpenSearch / Qdrant / Pinecone / …):

1. **Implement `VectorStore`** — `search` must return cosine-similarity-scored hits (the differ's 0.85 threshold and the cold-start `count()` guard both depend on the contract). Filter on the `sourceId` metadata key — the differ searches per-source.
2. **Register it** — add a `vectorRegistry.register("<name>", () => new YourStore(...))` line in `bootstrapVectorStore` and widen the `vectorProvider` Zod enum in `src/config.ts`.
3. **Honor the cold-start contract** — a fresh backend must report `count() === 0` for an unseeded source so the pipeline's baseline guard suppresses the first-crawl alert storm.
4. **Test it** — implement the interface against an in-process fake or a containerized backend; don't mock the driver. See `src/providers/vectors.test.ts`.

## Conventions

- **Provider registry, not inline construction.** LLM / embeddings / vectors are each a `createRegistry<T>(kind)` returning typed `{ register, get, has, names }`. Pick the implementation by config; `src/index.ts` is the only place real clients are built. Swapping a backend is a one-file change to the bootstrap.
- **Bedrock-default LLM.** Bedrock (Converse for the LLM, Titan for embeddings) is the default and runs on the AWS credential chain — IRSA on the cluster, no keys. Anthropic/OpenAI are alternates that only register when their key is present.
- **Prompt caching.** The analysis system prompt is identical on every diff, so the Converse request marks a `cachePoint` after the system block. Cache hits are emitted as a metric — see `ARCHITECTURE.md` § Prompt caching.
- **Circuit breakers on every external call** — per-host for the crawler's HTTP fetcher, per-provider for LLM + embeddings, and around the Slack alert sink. Threshold-based, no library.
- **Single-writer scheduler + crawl mutex.** `replicaCount: 1`. The scheduler runs one global crawl over all sources on an interval; an in-process mutex prevents the scheduler and a `/competitive-intelligence crawl` from overlapping. Scaling horizontally without leader election would double-crawl and race the differ — don't.
- **SSRF-guarded crawling.** Every outbound crawl URL passes `guardUrl` (`src/crawler/url-guard.ts`) — rejects loopback, RFC1918, link-local, and cloud-metadata addresses before the fetch.
- TypeScript strict, ESM NodeNext, Node ≥ 24. Zod at every boundary (config, sources, log level, LLM analysis output). Structured JSON logging to stderr via a hand-rolled logger (`src/logger.ts`); stdout is reserved for CLI output. Explicit timeouts on every external call (Bedrock/Anthropic/OpenAI, pgvector, Slack).

## Pointers

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — bounded contexts, the crawl→alert data flow, load-bearing decisions, prompt-cache measurement, and where the boundaries sit (landing-zone substrate, eks-gitops addons)
- [`CLAUDE.md`](CLAUDE.md) — per-module breakdown, configuration, conventions, test map
- [`README.md`](README.md) — front door: run, test, deploy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the crawl-source / provider / vector-backend recipes + the test contract + PR flow
- [`SECURITY.md`](SECURITY.md) — reporting, posture (SSRF guard, IRSA-only, default-deny network), known limitations
- [`chart/README.md`](chart/README.md) — template-by-template chart reference + the per-tenant infra it expects
- [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md) — the stack-wide view
- [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) — the operator that reconciles the Platform CR
- [`landing-zone`](https://github.com/nanohype/landing-zone) — the `competitive-intelligence-platform` substrate (Aurora pgvector + IRSA + Secrets Manager) the chart's IRSA role and data store live in
