# Contributing

## Workflow

1. Branch from `main` with a conventional prefix: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`.
2. Run `task ci` locally before pushing. CI must pass.
3. Use the structured commit-message format from `~/.claude/CLAUDE.md` (section headers, file-level detail, scaled verbosity).
4. Open a PR. Reviews are required for changes under `src/providers/`, `src/crawler/`, `src/pipeline/`, and `chart/`.

## Local prereqs

| Tool     | Version                           |
| -------- | --------------------------------- |
| `node`   | see `package.json` engines (≥ 24) |
| `npm`    | bundled with Node 24              |
| `helm`   | matches the target cluster minor  |
| `task`   | latest                            |
| `docker` | for the container build job       |

Local dev runs against `VECTOR_PROVIDER=memory` with no database. To exercise the durable path, point `VECTOR_PROVIDER=pgvector` + `DATABASE_URL` (or `PG*`) at a Postgres with the `vector` extension — e.g. `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=ci pgvector/pgvector:pg16`.

## Layout

See [README.md](./README.md), [AGENTS.md](./AGENTS.md), and [ARCHITECTURE.md](./ARCHITECTURE.md).

## The test contract

Tests run on Vitest (`npm test`), colocated as `src/**/*.test.ts`. The contract:

1. **Mock providers by implementing the interface, not SDK internals.** Every external boundary goes through a typed interface — `LlmProvider`, `EmbeddingProvider`, `VectorStore` — selected by the registry. A test supplies a fake that implements the interface; it does **not** `vi.mock(<sdk-package>)` or patch the AWS/Slack/cheerio SDK. The differ, pipeline, and intel tests all run against in-process fakes this way.
2. **New boundary code needs an interface-injected test.** Adding a provider or vector backend means adding a test that drives the new implementation (or a fake of it) through the same interface the rest of the system uses.
3. **New pure logic needs a direct test.** The chunker, differ, and URL guard are pure (or near-pure) and tested directly — see `src/pipeline/chunker.test.ts`, `src/pipeline/differ.test.ts`, `src/crawler/url-guard.test.ts`.
4. **Vendored logic is tested upstream; wiring is tested here.** `src/vendor/runtime/` modules carry their unit tests at the source of truth (`nanohype/library/runtime`) — don't duplicate them. Local tests cover this app's wiring of them: `src/resilience/circuit-breaker.test.ts` (config mapping + gauge lifecycle) and `src/crawler/fetcher.test.ts` (per-host trip, window decay, half-open recovery in the fetch pipeline).

Cover the cold-start path when you touch the pipeline or a vector backend: empty store → baseline (no alerts); populated store → real diffs.

## Adding a crawl source

Sources are data, not code — edit `sources.json` (validated against the Zod schema in `src/crawler/sources.ts`; `sources.example.json` is the reference).

1. Add `{ competitor, url, type, selectors? }`. `type` is one of `changelog` / `blog` / `pricing` / `careers` / `docs` / `general`; `selectors.content` scopes the main region and `selectors.exclude` strips nav/footer noise. The differ groups history on `id` (defaults to `<competitor>:<type>`; set it explicitly to monitor two same-type pages for one competitor — changing it resets that source).
2. No redeploy logic; the next crawl picks it up. Its first crawl is treated as a baseline by the cold-start guard, so a new source never produces a one-time alert flood.

## Adding an LLM or embedding provider

1. Implement `LlmProvider` (`chat`) in `src/providers/llm.ts` or `EmbeddingProvider` (`embed`) in `src/providers/embeddings.ts`, wrapping the external call in a `createBreaker` circuit breaker like the existing providers.
2. Register it in `bootstrapLlm` / `bootstrapEmbeddings` (gate on the credential it needs), and widen the `llmProvider` / `embeddingProvider` Zod enum in `src/config.ts`.
3. Add the env var to `.env.example`. Keep Bedrock the default — new non-Anthropic LLM providers stay opt-in (LLM policy).
4. Add a `src/providers/vectors.test.ts`-style test driving the new implementation through its interface — no SDK mocking.

## Adding a vector backend

1. Implement `VectorStore` (`upsert` / `search` / `delete` / `deleteByMetadata` / `count`) in `src/providers/vectors.ts`. `search` returns cosine-similarity-scored hits filterable by the `sourceId` metadata key; a fresh, unseeded source must report `count() === 0` so the cold-start guard suppresses its first-crawl alerts.
2. Register it in `bootstrapVectorStore` and widen the `vectorProvider` Zod enum in `src/config.ts`. Keep `memory` available for local dev / tests.
3. Add a `src/providers/vectors.test.ts`-style test (upsert / search / filter / deleteByMetadata / count) against an in-process fake or a containerized backend — don't mock the driver.

## Deploy contract

This app ships as a Platform tenant: a Helm `chart/`, a `platform.yaml` (Platform + BudgetPolicy CRs), and a `gitops/applicationset-entry.yaml`. Per-tenant AWS substrate (Aurora pgvector, IAM, Secrets Manager) lives in `landing-zone` (the `competitive-intelligence-platform` component); cluster addons live in `eks-gitops`. Do not add IAM, cloud resources, or cluster addons to the chart — see [ARCHITECTURE.md](./ARCHITECTURE.md#boundaries).

## Code of Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
