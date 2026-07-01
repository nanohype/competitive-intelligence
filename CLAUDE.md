# competitive-intelligence

Competitive-intelligence radar — crawls competitor sites, semantic-diffs each page against its own history, and alerts Slack when something meaningfully changes.

> The repo, npm package, OTel `service.name` / `agents.platform`, image repo, `competitive-intelligence/<env>/*` secret prefixes, and the Slack slash command (`/competitive-intelligence`) are all the literal name. The default alert channel is `#competitive-intel` — a short handle the team watches.

## What This Is

A standalone Platform tenant of the `protohype` team on the `eks-agent-platform` operator. It monitors a configured set of competitor pages: crawl → chunk → embed → semantic-diff → (if significant) LLM analysis → Slack alert. The accumulated intelligence is queryable over Slack (`/competitive-intelligence query`) and the CLI.

Built around a provider-registry seam — LLM, embeddings, and vector store are each a `createRegistry<T>()` of named implementations selected by config, so swapping a backend is a one-file change to the bootstrap. Bedrock is the default for LLM (Converse) and embeddings (Titan v2), running on the AWS credential chain → EKS Pod Identity on the cluster, no keys. Anthropic and OpenAI are pluggable alternates.

## How It Works

```
sources.json → Crawler → Pipeline (chunk → embed → semantic diff) → Alert Engine → Slack (#competitive-intel)
                                                                          ↕
                                                               Intel Engine (query via /competitive-intelligence or CLI)
```

Core insight: semantic diffing via embedding cosine similarity, not text comparison. A chunk is "new" only when its cosine similarity to the best stored match for the same source is below 0.85; a page's change score is `newChunks / totalChunks`. Only semantically novel content above `SIGNIFICANCE_THRESHOLD` triggers an alert.

**Durability + cold start:** the production vector backend is durable pgvector (Aurora), so history survives pod restarts and rollouts — the next crawl diffs against real history instead of re-flagging everything as new. A cold-start guard in the pipeline backs that up: a source whose stored `count()` is zero on a crawl is treated as baseline seeding (ingest + embed, no alert), covering the genuine first deploy and any empty-backend start. No manual baseline step and no threshold workaround are needed.

## Architecture

- **src/providers/** — Self-registering provider registry. LLM (`llm.ts`: Bedrock/Anthropic/OpenAI), embeddings (`embeddings.ts`: Bedrock Titan/OpenAI), vector store (`vectors.ts`: `MemoryVectorStore` for dev/tests + `PgVectorStore` for durable production, both behind the `VectorStore` interface). All via `createRegistry<T>()`. The Bedrock LLM marks a Converse `cachePoint` after the static analysis system prompt — token usage is emitted per kind as `bedrock.{input,output,cache_read,cache_write}_tokens` so cache effectiveness is measurable. Every external call carries an explicit timeout (Bedrock via `requestHandler` + an `AbortSignal.timeout` deadline, Anthropic/OpenAI via the SDK `timeout` option).
- **src/crawler/** — HTTP fetcher with per-host circuit breakers, HTML→text via cheerio scoped by `selectors`. SSRF-guarded (`url-guard.ts`) — every outbound URL rejects loopback/RFC1918/link-local/metadata addresses before the fetch. Sequential crawling. `sources.ts` Zod-validates `sources.json` on load.
- **src/pipeline/** — Recursive text chunker with overlap → embed → semantic diff against stored vectors → `deleteByMetadata` old chunks → upsert new. Holds the cold-start baseline guard.
- **src/intel/** — Query facade: embed question → vector search → LLM-generated answer with context. `analysis.ts` holds the LLM change analysis (significance + signal extraction) and the cached analysis/query system prompts.
- **src/alerts/** — Threshold gating on change score → LLM analysis → Slack Block Kit formatting → dispatch through the alert sink.
- **src/slack/** — `@slack/bolt` app. @mention + DM query handlers (`handlers.ts`), `/competitive-intelligence query|crawl|status` slash command (`commands.ts`). Socket Mode when `SLACK_APP_TOKEN` is set, HTTP mode otherwise.
- **src/scheduler/** — `setInterval`-based job runner. One global crawl over all sources at a configurable interval. The crawl mutex (in `index.ts`) prevents the scheduler and a slash-command crawl from overlapping.
- **src/index.ts** — Bootstrap. Wires config → providers → sources → crawl loop → intel/alert engines → Slack bot → scheduler. Runs a `node:http` server for `/health` (liveness) + `/readyz` (readiness — vector store reachable, Slack connected in Socket Mode) on `PORT`, independent of Slack transport. Runs an initial crawl on boot, then on interval. Graceful shutdown on SIGINT/SIGTERM.
- **src/cli.ts** — One-off `crawl` and `query` commands for use without Slack. Reuses `crawlAll` (per-source progress via its `onResult` callback) and renders output through **src/display.ts** (ANSI CLI presentation layer).
- **OTel init** — telemetry is started once, by the Dockerfile's `--require @opentelemetry/auto-instrumentations-node/register` preload (it must load before any instrumented module is imported, which app code cannot guarantee). All export config is env-driven (`OTEL_*` in the chart); there is no programmatic SDK in the app. `OTEL_SDK_DISABLED=true` short-circuits it for tests/CI/local.
- **src/metrics.ts** — OTel metrics surface (`timing` → ms histogram, `distribution` → unitless histogram, `counter` → monotonic counter, plus an observable `circuit_breaker.open` gauge). Instrument names map to the `competitive_intelligence_*` series the Grafana dashboard + PrometheusRule query. Exported OTLP to the cluster OTel Collector. Degrades to a no-op when no provider is registered (tests).

## Commands

```bash
npm run dev          # Start full system (scheduler + Slack bot + /health)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled output
npm run crawl        # One-off crawl via CLI
npm run query -- "question"  # One-off query via CLI
npm test             # vitest run
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run format:check # prettier --check
```

Chart + container:

```bash
npm run chart:lint   # helm lint chart
task ci              # full local gate (build + lint + typecheck + format:check + test + helm + docker)
```

## Configuration

All config via env vars, validated by Zod in `src/config.ts`. See `.env.example`. In-cluster, secret values come from AWS Secrets Manager (`competitive-intelligence/<env>/*`) via the chart's ExternalSecret, synced into one Kubernetes Secret consumed `envFrom`; `.env.example` is for local dev only.

- `LLM_PROVIDER` — bedrock (default), anthropic, or openai
- `EMBEDDING_PROVIDER` — bedrock (default) or openai
- `AWS_REGION` — for Bedrock. Uses the AWS credential chain → EKS Pod Identity on the cluster, no API keys
- `BEDROCK_LLM_MODEL` / `BEDROCK_EMBEDDING_MODEL` — model IDs (LLM defaults to a cross-region Claude Sonnet inference profile; embeddings to Titan Embed v2)
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — only when using those providers directly
- `ANTHROPIC_LLM_MODEL` / `OPENAI_LLM_MODEL` — direct-API model IDs (defaults `claude-sonnet-4-6` / `gpt-4o`)
- `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` — OpenAI embedding model + vector size (default 1024; 1024 for Titan v2, 1536 for OpenAI)
- `VECTOR_PROVIDER` — `pgvector` in cluster (durable, restart-safe), `memory` for local dev/tests
- `DATABASE_URL` / `PG*` — Postgres connection for pgvector; in cluster these come from `competitive-intelligence/<env>/db-credentials`
- `PG_CA_PATH` — optional CA bundle for verifying the pgvector TLS connection; unset → Node's built-in trust store
- `SIGNIFICANCE_THRESHOLD` — 0–1, minimum change score to trigger an alert (default 0.3)
- `CRAWL_INTERVAL_MINUTES` — default 60
- `CRAWL_TIMEOUT_MS` — per-page fetch timeout (default 30000)
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `SLACK_APP_TOKEN` — Slack; absent → CLI-only
- `SLACK_ALERT_CHANNEL` — alert channel (default `#competitive-intel`)
- `USER_AGENT` — crawl request User-Agent (default `competitive-intelligence/0.1.0`)
- `PORT` — HTTP health-server port (default 3000); in Slack HTTP mode the Bolt receiver binds `PORT + 1`
- `NODE_ENV` — development (default), production, or test
- `LOG_LEVEL` — debug, info (default), warn, error. Zod-validated.

Bedrock needs model access to Claude Sonnet and Titan Embed v2 in the deployment region. Sources are defined in `sources.json` (see `sources.example.json`), Zod-validated on load.

## Conventions

- TypeScript, ESM (`"type": "module"`, `.js` extensions in imports)
- Node ≥ 24
- Zod for all validation (config, sources, log level)
- Structured JSON logging to stderr (`src/logger.ts`) — stdout reserved for CLI display; OTel `trace_id`/`span_id` correlated
- Provider registry pattern: `createRegistry<T>(kind)` returns typed `{ register, get, has, names }`
- Circuit breaker for external calls — per-host for the HTTP fetcher, per-provider for LLM and embeddings
- Bedrock-default LLM; prompt-cached analysis system prompt via Converse `cachePoint`
- No framework lock-in for LLMs — direct SDK calls via the provider interface
- Single-writer: `replicaCount: 1`; the crawl mutex prevents overlapping scheduler + slash-command runs (no horizontal scale without leader election)

## Testing

Tests are colocated as `src/**/*.test.ts`. Run with `npm test`.

- `src/providers/registry.test.ts` — registry factory (register, get, has, names, fresh instances)
- `src/providers/vectors.test.ts` — memory store (upsert, search, filter, deleteByMetadata, count)
- `src/pipeline/chunker.test.ts` — recursive text splitting (short, long, IDs, overlap)
- `src/pipeline/differ.test.ts` — semantic diff (empty store → baseline, high similarity, custom threshold)
- `src/resilience/circuit-breaker.test.ts` — trip, half-open probe, recovery
- `src/crawler/url-guard.test.ts` — SSRF guard (scheme, loopback, RFC1918, link-local/metadata, IPv6)

When adding tests: mock providers by implementing the interface directly (`LlmProvider` / `EmbeddingProvider` / `VectorStore`) — don't mock SDK internals. Cover the cold-start path (empty store → baseline, no alerts) when touching the pipeline or a vector backend.

## Dependencies

- `@aws-sdk/client-bedrock-runtime` — Bedrock LLM (Converse) + embeddings (Titan); on-account inference
- `@anthropic-ai/sdk` / `openai` — direct API providers (optional)
- `@slack/bolt` — Slack bot
- `pg` — PostgreSQL driver for the durable pgvector backend
- `cheerio` — HTML parsing
- `zod` — config + schema validation
- `@opentelemetry/*` — traces + metrics; the `--require` auto-instrumentations hook in the Dockerfile traces http/fetch/aws-sdk/pg before user code

## Deploy

Ships as the `competitive-intelligence` Platform tenant. No in-repo IaC and no manual rollout — ArgoCD reconciles the chart from git.

1. **Substrate** — `landing-zone/components/aws/competitive-intelligence-platform/` provisions Aurora Serverless v2 (pgvector), the IAM role, and Secrets Manager entries. It owns the IAM role and the EKS Pod Identity association binding the ServiceAccount to it; the Aurora endpoint feeds `tenantInfra.*`.
2. **Platform CR** — `kubectl apply -f platform.yaml` once. The operator reconciles Namespace `tenants-protohype`, ResourceQuota, default-deny NetworkPolicy, ArgoCD AppProject, and the tenant IRSA. Wait for `Ready`.
3. **GitOps** — `gitops/applicationset-entry.yaml` is registered in `nanohype/eks-gitops`. ArgoCD renders the chart per env and rolls out the Deployment. New image tags flow through the release workflow → GHCR → ArgoCD.

Observability is cluster-level via eks-gitops: app stderr → log forwarder → Loki; OTLP traces + metrics → `grafana-agent.monitoring.svc.cluster.local:4318` → Tempo + AMP. No per-pod sidecars. Required resource attrs `agents.tenant=protohype` + `agents.platform=competitive-intelligence` ride on every span/metric. See `chart/README.md` for the full template-by-template description.
