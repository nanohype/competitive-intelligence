# competitive-intelligence

Competitive-intelligence radar — crawls competitor sites, semantic-diffs each page against its own history, and alerts Slack when something meaningfully changes.

> The repo, npm package, OTel `service.name` / `agents.platform`, image repo, and `competitive-intelligence/<env>/*` secret prefixes are all the literal name. The default alert channel is `#competitive-intel` — a short handle the team watches.

## What This Is

A standalone Platform tenant of the `strategy` team on the `eks-agent-platform` operator. It has two halves. An autonomous **push radar**: crawl → chunk → embed → semantic-diff → (if significant) LLM analysis → Slack alert, on a schedule. And an interactive **pull surface**: an MCP server whose tools any Claude surface (Claude Tag et al.) calls to search the accumulated intelligence, trigger a crawl, and inspect status/sources. The same intelligence is also queryable from the CLI.

Built around a provider-registry seam — LLM, embeddings, and vector store are each a `createRegistry<T>()` of named implementations. The vector store has real alternates (memory for dev, pgvector for production); the model paths have exactly one arm each, the Platform's ModelGateway, because reaching a model any other way would bypass the guardrail, the capture and the per-tenant attribution the gateway applies. Alternative models are routes on the `ModelGateway` CR, where they inherit all three. The app holds no model credential.

## How It Works

```
sources.json → Crawler → Pipeline (chunk → embed → semantic diff) → Alert Engine → Slack sink (#competitive-intel)
                                                                          ↕
                                                               Intel Engine ──→ MCP server (search_intel, …) ← Claude surfaces
                                                                            └─→ CLI query
```

Core insight: semantic diffing via embedding cosine similarity, not text comparison. A chunk is "new" only when its cosine similarity to the best stored match for the same source is below 0.85; a page's change score is `newChunks / totalChunks`. Only semantically novel content above `SIGNIFICANCE_THRESHOLD` triggers an alert.

**Durability + cold start:** the production vector backend is durable pgvector (Aurora), so history survives pod restarts and rollouts — the next crawl diffs against real history instead of re-flagging everything as new. A cold-start guard in the pipeline backs that up: a source whose stored `count()` is zero on a crawl is treated as baseline seeding (ingest + embed, no alert), covering the genuine first deploy and any empty-backend start. No manual baseline step and no threshold workaround are needed.

## Architecture

- **src/providers/** — Self-registering provider registry. LLM (`llm.ts`: the ModelGateway, speaking Anthropic Messages), embeddings (`embeddings.ts`: the ModelGateway's embeddings route, speaking the OpenAI embeddings shape the gateway translates to Titan), vector store (`vectors.ts`: `MemoryVectorStore` for dev/tests + `PgVectorStore` for durable production, both behind the `VectorStore` interface). All via the vendored `createRegistry<T>()`. The LLM provider marks an ephemeral cache breakpoint after the static analysis system prompt — token usage is emitted per kind as `bedrock.{input,output,cache_read,cache_write}_tokens` so cache effectiveness is measurable. Every external call carries an explicit timeout (the Messages client via its `timeout` option, the embeddings call via `AbortSignal.timeout`), and each is circuit-breakered.
- **src/crawler/** — HTTP fetcher with per-host circuit breakers, HTML→text via cheerio scoped by `selectors`. SSRF-guarded (`url-guard.ts`) — every outbound URL rejects loopback/RFC1918/link-local/metadata addresses before the fetch. Sequential crawling. `sources.ts` Zod-validates `sources.json` on load.
- **src/vendor/runtime/** — Vendored `@nanohype/runtime` modules: `circuit-breaker.ts` (sliding-window breaker, injectable clock, onOpen/onClose transition hooks), `guardrails.ts` (reserved-tag stripping + an unforgeable per-call fence, applied to crawled page content and retrieved chunks before either reaches a prompt), `registry.ts` (`createRegistry<T>`), `metrics.ts` (the lazy namespace-qualified OTel instrument core behind `src/metrics.ts`), and `logger.ts` (the JSON-lines + OTel-trace-correlation core behind `src/logger.ts`). Byte-identical copies of `nanohype/library/runtime` — the same consumption model as the vendored `tenant-chart-base` chart. `scripts/sync-vendored.mjs` (re)writes the copies from a nanohype checkout (`NANOHYPE_DIR`, default `../nanohype`); CI runs it with `--check` and fails on drift. Never edit these locally — fix upstream, re-sync.
- **src/resilience/** — App wiring over the vendored breaker: `createBreaker(name, opts)` maps `failureThreshold`/`windowMs`/`halfOpenAfterMs` (defaults 5 / 5 min / 60 s) and raises/lowers the `circuit_breaker.open` gauge on trip/success/reset. The breaker trips on failure density within the rolling window, not on a consecutive count.
- **src/pipeline/** — Recursive text chunker with overlap → embed → semantic diff against stored vectors → `deleteByMetadata` old chunks → upsert new. Holds the cold-start baseline guard.
- **src/intel/** — Query facade with two entry points over one retrieval path. `retrieve` embeds the question → vector search → returns the ranked chunks with their source metadata (the context the MCP `search_intel` tool hands back). `query` composes an LLM answer over that same context (the CLI answer path and the in-boundary composed-answer option). `analysis.ts` holds the LLM change analysis (significance + signal extraction) and the cached analysis/query system prompts. Both prompts fence their untrusted span: the crawled page in `analyzeChanges`, the retrieved chunks in `answerQuery`. The crawled page is a competitor's own site — they can notice the crawler and serve it anything — and retrieval carries that same text in on someone else's question, so the attacker never has to be the caller. `evals/` measures whether the model actually holds that line.
- **src/alerts/** — Threshold gating on change score → LLM analysis → Slack Block Kit formatting → dispatch through the alert sink. `slack-sink.ts` is the outbound sink: `@slack/web-api` `chat.postMessage`, circuit-breakered with a 10s timeout. Deterministic Block Kit alerts are the radar's product — they are not re-generated by a model.
- **src/mcp/** — The pull/query surface. A streamable-HTTP MCP server (`server.ts`, the official `@modelcontextprotocol/sdk`) on `MCP_PORT`, and the tool set (`tools.ts`): `search_intel(question, competitor?, topK?)` returns retrieved context (ranked chunks + source metadata — the consuming model does the reasoning), `trigger_crawl()` calls the in-process single-writer crawl, `status()` reports uptime/mem/version, `list_sources()` returns the Zod-validated source set. Every tool input is Zod-validated at the boundary; a bad argument comes back as an `isError` tool result, an unknown tool as a protocol error. The mcp-tunnel is the only ingress (chart NetworkPolicy). `oauth.ts` is an **optional** OAuth 2.1 resource-server layer (off unless `MCP_AUTH=workos`) that gates `/mcp` on a WorkOS AuthKit bearer token: it serves Protected Resource Metadata (RFC 9728), enforces `Authorization: Bearer` with the RFC 9728 §5.1 `WWW-Authenticate` challenge on failure, and validates the token with `jose` (signature via the WorkOS JWKS, `iss`, `exp`/`nbf`, and `aud` = this server's canonical URI — the RFC 8707 audience binding, a hard reject on mismatch). WorkOS is the authorization server (dashboard-configured); this holds no client secret. The verifier is injectable so tests exercise the real jose path against a local key set. Self-contained for later extraction into the shared runtime library. See `docs/mcp-oauth.md`.
- **src/scheduler/** — `setInterval`-based job runner. One global crawl over all sources at a configurable interval. The crawl mutex (in `index.ts`) prevents the scheduler and an MCP `trigger_crawl` from overlapping.
- **src/index.ts** — Bootstrap. Wires config → providers → sources → crawl loop → intel/alert engines → outbound alert sink → MCP server → scheduler, all in one process (single writer). Runs a `node:http` server for `/health` (liveness) + `/readyz` (readiness — vector store reachable) on `PORT`, and the MCP streamable-HTTP server on `MCP_PORT`. Runs an initial crawl on boot, then on interval. Graceful shutdown on SIGINT/SIGTERM (stops the scheduler, closes the MCP server + health server).
- **src/cli.ts** — One-off `crawl` and `query` commands for use without Slack. Reuses `crawlAll` (per-source progress via its `onResult` callback) and renders output through **src/display.ts** (ANSI CLI presentation layer).
- **OTel init** — telemetry is started once, by the Dockerfile's `--require @opentelemetry/auto-instrumentations-node/register` preload (it must load before any instrumented module is imported, which app code cannot guarantee). All export config is env-driven (`OTEL_*` in the chart); there is no programmatic SDK in the app. `OTEL_SDK_DISABLED=true` short-circuits it for tests/CI/local.
- **src/metrics.ts** — OTel metrics surface (`timing` → ms histogram, `distribution` → unitless histogram, `counter` → monotonic counter, plus an observable `circuit_breaker.open` gauge). Instrument names map to the `competitive_intelligence_*` series the Grafana dashboard + PrometheusRule query. Exported OTLP to the cluster OTel Collector. Degrades to a no-op when no provider is registered (tests).

## Commands

```bash
npm run dev          # Start full system (scheduler + alert sink + MCP server + /health)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled output
npm run crawl        # One-off crawl via CLI
npm run query -- "question"  # One-off query via CLI
npm test             # vitest run (unit + the offline eval tier)
npm run eval         # the model tier — needs EVAL_LLM (see evals/README.md)
npm run lint         # Biome
npm run typecheck    # tsc --noEmit
npm run format:check # Biome
npm run sync:vendored # re-vendor runtime, config + chart base from nanohype at the pinned commit
npm run sync:vendored -- --ref=<sha> # adopt a newer library: re-vendor and move the pin together
npm run sync:vendored:check # blocking gate: vendored bytes == nanohype at the pinned commit
npm run sync:vendored:freshness # scheduled-only: has the pin fallen behind upstream? never a merge gate
npm run sync:vendored:selftest # break the gate's inputs 17 ways; fail unless every break is rejected
```

Chart + platform CRs + container:

```bash
npm run chart:lint       # helm lint chart
npm run platform:validate # validate platform.yaml against the vendored operator CRD schemas, then self-test the gate
npm run schemas:sync # re-vendor those schemas + digests from the pinned eks-agent-platform ref
npm run schemas:sync -- --ref=latest # adopt the newest operator schemas: re-vendor and move the pin together
npm run schemas:check # blocking gate: vendored bytes == upstream at the pinned ref
npm run schemas:freshness # scheduled-only: has the pin fallen behind upstream? never a merge gate
npm run schemas:selftest # blocking gate: the freshness report names a command, not a commit — and that command works
task ci                  # every gate that needs only this checkout (editorconfig runs in CI, from nanohype/.github)
```

## Configuration

All config via env vars, validated by Zod in `src/config.ts`. See `.env.example`. In-cluster, secret values come from AWS Secrets Manager (`competitive-intelligence/<env>/*`) via the chart's ExternalSecret, synced into one Kubernetes Secret consumed `envFrom`; `.env.example` is for local dev only.

- `MODEL_GATEWAY_ENDPOINT` — the Platform's ModelGateway. Every model call goes here; the app holds no model credential of any kind. The routes resolve to `us.anthropic.claude-sonnet-5` for analysis and `amazon.titan-embed-text-v2:0` for embeddings, declared on the `ModelGateway` CR in `platform.yaml` — change a model there, not here. This is the gateway *root*: each client-facing API sits under its own prefix, so the embeddings provider requests `/v1/embeddings` off it directly while the Messages client is handed `anthropicBaseUrl()` for the `/anthropic/v1/messages` endpoint
- `LLM_ROUTE` / `EMBEDDING_ROUTE` — route names on that gateway (defaults `default` / `embeddings`), not model IDs. The `ModelGateway` CR maps each to a Bedrock model
- `EMBEDDING_DIMENSIONS` — the pgvector column width, forwarded to the embeddings route and asserted on every returned vector (default 1024, matching Titan v2)
- `VECTOR_PROVIDER` — `pgvector` in cluster (durable, restart-safe), `memory` for local dev/tests
- `DATABASE_URL` / `PG*` — Postgres connection for pgvector; in cluster these come from `competitive-intelligence/<env>/db-credentials`
- `PG_CA_PATH` — optional CA bundle for verifying the pgvector TLS connection; unset → Node's built-in trust store
- `SIGNIFICANCE_THRESHOLD` — 0–1, minimum change score to trigger an alert (default 0.3)
- `CRAWL_INTERVAL_MINUTES` — default 60
- `CRAWL_TIMEOUT_MS` — per-page fetch timeout (default 30000)
- `SLACK_BOT_TOKEN` — bot token for the outbound alert sink (`chat:write`); absent → alerts log to stderr instead of posting
- `SLACK_ALERT_CHANNEL` — alert channel (default `#competitive-intel`)
- `USER_AGENT` — crawl request User-Agent (default `competitive-intelligence/0.1.0`)
- `PORT` — HTTP health-server port for `/health` + `/readyz` (default 3000)
- `MCP_PORT` — MCP streamable-HTTP server port, the pull/query surface (default 3001)
- `MCP_AUTH` — `none` (default, open port behind the mcp-tunnel) or `workos` (enforce a WorkOS AuthKit bearer token on `/mcp`, making it a Claude custom connector). See `docs/mcp-oauth.md`
- `WORKOS_AUTHKIT_ISSUER` — WorkOS AuthKit issuer (`https://<tenant>.authkit.app`); required when `MCP_AUTH=workos`
- `MCP_PUBLIC_URL` — this server's canonical public `/mcp` URL — the RFC 8707 token audience; required when `MCP_AUTH=workos`
- `MCP_AUTH_SCOPES` — optional space/comma-delimited scopes every MCP request must present
- `NODE_ENV` — development (default), production, or test
- `LOG_LEVEL` — debug, info (default), warn, error. Zod-validated.

The gateway needs Bedrock model access to Claude Sonnet and Titan Embed v2 in the deployment region — the grant is on the tenant role the gateway runs as, not on this app. Sources are defined in `sources.json` (see `sources.example.json`), Zod-validated on load.

## Conventions

- TypeScript, ESM (`"type": "module"`, `.js` extensions in imports)
- Node ≥ 24
- Zod for all validation (config, sources, log level)
- Structured JSON logging to stderr (`src/logger.ts`) — stdout reserved for CLI display; OTel `trace_id`/`span_id` correlated
- Provider registry pattern: `createRegistry<T>(kind)` returns typed `{ register, get, has, names }` — vendored from `@nanohype/runtime`
- Circuit breaker for external calls — per-host for the HTTP fetcher, per-provider for LLM and embeddings. Sliding-window semantics (vendored from `@nanohype/runtime`, wired via `src/resilience/`): trips on failure density within the window, single half-open probe after the cooldown
- Vendored modules under `src/vendor/runtime/` stay byte-identical to `nanohype/library/runtime` at the commit pinned in `scripts/vendored.json` — behavior changes land upstream with their tests, then `npm run sync:vendored -- --ref=<sha>` here, which re-vendors and moves the pin together so the recorded commit and the bytes on disk cannot describe different things. `sync:vendored:check` is the CI drift gate and reads upstream at that pin, so a merge in nanohype never turns this repo's required check red; `sync:vendored:freshness` asks whether the pin has fallen behind, weekly and off the blocking path
- `platform.yaml` is CI-validated against the real operator CRD schemas vendored under `schemas/crd/` (from `eks-agent-platform` at the SHA pinned in `schemas/crd/source.json`, with a SHA-256 per file recorded alongside it). The gate is tamper-evident and drift-evident in two independent places: the validator hashes every vendored schema against its recorded digest before parsing it — offline, so an edited copy fails on a laptop too — and `schemas:check` compares the copies to the operator repo at the pinned SHA, catching a tamper that also rewrote the digest as well as a pin that no longer describes the committed schemas. Pin fidelity is the whole of the blocking gate — whether the pin has fallen behind upstream is asked by `schemas:freshness` on a weekly schedule, so a required check never flips red because another repo moved. The walker is strict about unknown fields — controller-gen emits no `additionalProperties: false`, so a misspelled spec key would otherwise validate clean and then be pruned silently by the apiserver. It also asserts scope (`Tenant` cluster-scoped, `Platform`/`BudgetPolicy` namespaced), the CRD's model-allow-list CEL rule, and that the tenant/platform names agree across the CRs and every chart values file's OTel attributes. `--self-test` breaks all of that in memory and fails unless each break is rejected
- A scheduled freshness report is read long after it ran — `crd-schema-freshness` copies it verbatim into an issue body re-edited weekly and opened on an arbitrary day — so its remediation names `npm run schemas:sync -- --ref=latest`, which resolves the newest upstream commit touching the vendored path as the re-vendor runs, rather than a commit the run resolved and printed. `schemas:selftest` holds that on the emitted bytes against a real upstream repository it builds: exit 2 for a behind pin, no commit id the run resolved anywhere in the output, a remediation naming the command, and that command landing the pin on upstream's newest schema commit. It is on the blocking path, unlike the weekly report it constrains
- One model path: the Platform's ModelGateway. The analysis system prompt carries an ephemeral cache breakpoint so the stable prefix is cached rather than re-billed
- No framework lock-in for LLMs — the Anthropic Messages client behind the provider interface
- Single-writer: `replicaCount: 1`; the scheduler, alert sink, and MCP server share one process, and the crawl mutex prevents overlapping scheduler + `trigger_crawl` runs (no horizontal scale without leader election)

## Testing

Tests are colocated as `src/**/*.test.ts`. Run with `npm test`.

**Evals are a separate tier** (`evals/`, see its README). A test asserts the
code does what it says; an eval measures whether the *model* does, and the
answer is a rate. `npm test` runs the offline half — fixture validity and the
graders — on every PR. `npm run eval` runs the model half, which needs
`EVAL_LLM` and its own CI workflow. Setting `EVAL_LLM` means the tier must
run: a broken provider is a hard failure, never a skip, so a green eval check
always means the evals executed.

- `src/providers/vectors.test.ts` — memory store (upsert, search, filter, deleteByMetadata, count)
- `src/pipeline/chunker.test.ts` — recursive text splitting (short, long, IDs, overlap)
- `src/pipeline/differ.test.ts` — semantic diff (empty store → baseline, high similarity, custom threshold)
- `src/resilience/circuit-breaker.test.ts` — app wiring over the vendored breaker (config mapping, `circuit_breaker.open` gauge lifecycle)
- `src/mcp/tools.test.ts` — the four tool handlers via the pure `callTool` dispatcher (input validation, `search_intel` returning context, empty-store case, `trigger_crawl`/`list_sources`/`status` pass-through) against interface fakes — no SDK mocking
- `src/mcp/server.test.ts` — end-to-end: a real MCP client speaks the streamable-HTTP transport to a real in-process server (nothing in the SDK mocked; only the app's provider interfaces faked). Includes the OAuth-enabled path: metadata discovery over HTTP, the 401 challenge, audience-mismatch rejection, and a full authed handshake — a local RSA key set signs the tokens and backs the verifier (no live WorkOS, no SDK mocking)
- `src/mcp/oauth.test.ts` — the resource-server layer via the real `jose` path against an injected local key set: metadata content, 401 (missing/malformed→400/invalid/expired/wrong-issuer), the **audience-mismatch → 401** RFC 8707 security test, 403 insufficient scope, and acceptance of a correctly-audienced token
- `src/crawler/fetcher.test.ts` — fetch-pipeline breaker wiring (per-host trip, window decay, half-open recovery, SSRF guard before the breaker)
- `src/crawler/url-guard.test.ts` — SSRF guard (scheme, loopback, RFC1918, link-local/metadata, IPv6)
- `evals/harness.test.ts` — the offline eval tier: the golden set parses, has unique ids, spans more than one significance band, and gives every adversarial case something that can actually fail; plus the graders and the scorer (a missing result counts as a failure, never a pass)

Vendored `src/vendor/runtime/` logic (breaker state machine, registry factory) is unit-tested at its source of truth — `nanohype/library/runtime` — not duplicated here.

When adding tests: mock providers by implementing the interface directly (`LlmProvider` / `EmbeddingProvider` / `VectorStore`) — don't mock SDK internals. Cover the cold-start path (empty store → baseline, no alerts) when touching the pipeline or a vector backend.

## Dependencies

- `@anthropic-ai/sdk` — the Messages client, pointed at the Platform's ModelGateway. Embeddings need no client: the gateway's embeddings route takes a small JSON body over `fetch`
- `@modelcontextprotocol/sdk` — the MCP server (streamable HTTP), the pull/query surface
- `jose` — JWKS fetch + JWT verification for the optional MCP OAuth resource-server layer (`aud`/`iss`/`exp` in one `jwtVerify`)
- `@slack/web-api` — outbound alert sink (`chat.postMessage`)
- `pg` — PostgreSQL driver for the durable pgvector backend
- `cheerio` — HTML parsing
- `zod` — config + schema validation
- `@opentelemetry/*` — traces + metrics; the `--require` auto-instrumentations hook in the Dockerfile traces http/fetch/aws-sdk/pg before user code

## Deploy

Ships as the `competitive-intelligence` Platform tenant. No in-repo IaC and no manual rollout — ArgoCD reconciles the chart from git.

1. **Substrate** — the `main` `relational` datastore (Aurora Serverless v2, pgvector) is declared in `platform.yaml` (`spec.datastores`) and provisioned by the generic `tenant-substrate` component. The operator generates the datastore-access policy and binds the operator-owned `tenant-runtime` ServiceAccount to the tenant role via a Pod Identity association; the Aurora endpoint feeds `tenantInfra.*`. App secrets are seeded to Secrets Manager out of band.
2. **Platform CR** — `kubectl apply -f platform.yaml` once. It carries three documents: the cluster-scoped `Tenant` `strategy`, plus the `BudgetPolicy` and `Platform` authored in the `tenants-strategy` team namespace. The operator reconciles the workload namespace `tenants-competitive-intelligence`, its ResourceQuota, default-deny NetworkPolicy, the ArgoCD AppProject, and the tenant IAM role. Wait for `Ready`.
3. **GitOps** — `gitops/applicationset-entry.yaml` is registered in `nanohype/eks-gitops`. ArgoCD renders the chart per env and rolls out the Deployment. New image tags flow through the release workflow → GHCR → ArgoCD.

Observability is cluster-level via eks-gitops: app stderr → log forwarder → Loki; OTLP traces + metrics → `telemetry.monitoring.svc.cluster.local:4318` → Tempo + AMP. No per-pod sidecars. Required resource attrs `agents.tenant=strategy` + `agents.platform=competitive-intelligence` ride on every span/metric. See `chart/README.md` for the full template-by-template description.
