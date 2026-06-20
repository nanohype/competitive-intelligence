# Architecture

`competitive-intelligence` is a radar that watches competitor websites for meaningful change. It crawls a configured set of pages on an interval, embeds the content, semantic-diffs each page against its own history, and — when a change is significant — has an LLM analyze the new content and fire a Slack alert. Accumulated intelligence is queryable over Slack (`/competitive-intelligence`) and the CLI. This document covers the bounded contexts, the load-bearing decisions, the per-crawl data flow, and where the boundaries sit relative to the rest of the stack.

## Bounded contexts

The system organizes around eight contexts. Cross-boundary services go through a provider registry (`createRegistry<T>()`); `src/index.ts` is the one place real SDK clients are constructed and threaded in.

| Context        | Module path       | What it owns                                                                                                                                                                                                                                                                             |
| -------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **crawler**    | `src/crawler/`    | `crawlAll` fetches each source sequentially via a per-host circuit-breakered HTTP fetcher; `parser.ts` turns HTML into text via cheerio, scoped by an optional CSS selector. `url-guard.ts` SSRF-guards every outbound URL; `sources.ts` Zod-validates `sources.json` on load            |
| **pipeline**   | `src/pipeline/`   | `ingestAndDiff` runs chunk → embed → diff → replace per page. `chunker.ts` recursively splits text with overlap; `differ.ts` scores a chunk "new" when its best same-source match scores below the 0.85 cosine threshold (or there's no match). The cold-start baseline guard lives here |
| **intel**      | `src/intel/`      | `createIntelEngine` is the query facade (embed question → vector search → LLM answer with context). `analysis.ts` holds the LLM change-analysis (significance + signal extraction) and the query/analysis system prompts                                                                 |
| **alerts**     | `src/alerts/`     | `createAlertEngine.processDiffs` threshold-gates on change score, runs LLM analysis, formats Block Kit, and dispatches to the alert sink. `formatter.ts` builds the alert + digest blocks                                                                                                |
| **slack**      | `src/slack/`      | `@slack/bolt` app — @mention + DM query handlers (`handlers.ts`), the `/competitive-intelligence query\|crawl\|status` slash command (`commands.ts`), and the alert `sink` the alert engine dispatches through. Socket Mode when `SLACK_APP_TOKEN` is set, HTTP mode otherwise           |
| **providers**  | `src/providers/`  | The registry seam. `llm.ts` (Bedrock / Anthropic / OpenAI), `embeddings.ts` (Bedrock Titan / OpenAI), `vectors.ts` (`MemoryVectorStore` + `PgVectorStore` behind the `VectorStore` interface). All selected by config                                                                    |
| **scheduler**  | `src/scheduler/`  | `createScheduler` is a `setInterval`-based job runner. Runs one global crawl over all sources at `CRAWL_INTERVAL_MINUTES`. The crawl mutex (in `src/index.ts`) prevents the scheduler and a slash-command crawl from overlapping                                                         |
| **resilience** | `src/resilience/` | `CircuitBreaker` — a threshold-based breaker used per-host by the fetcher and per-provider by the LLM/embeddings providers. Trip → fail fast → half-open probe → recover                                                                                                                 |

Cross-cutting: `src/config.ts` (Zod env validation, fail-fast at boot), `src/logger.ts` (hand-rolled structured JSON logging to stderr), `src/metrics.ts` (OTel timing/counter/gauge surface), `src/cli.ts` (one-off `crawl`/`query`) with `src/display.ts` (ANSI CLI presentation), `src/index.ts` (bootstrap + the `/health`+`/readyz` HTTP server). OTel is initialized by the Dockerfile's auto-instrumentations `--require` preload (env-driven config), not by app code.

## Key decisions

### Semantic diff via cosine, not text comparison

A page is "changed" when its content is **semantically** new, not when its bytes differ. Each chunk is embedded and compared (cosine similarity) against the best stored match for the same source; a chunk counts as new only when that similarity falls below 0.85 (or there's no prior match). The page's change score is `newChunks / totalChunks`. This is the whole point of the radar: a reworded paragraph, a reordered nav, or a changed timestamp doesn't fire — a new enterprise tier, a deprecated API, or a fresh hiring page does. Text diffing would drown the channel in noise; cosine diffing surfaces meaning.

### Durable pgvector for restart-safety, with a cold-start baseline guard

History has to survive the pod. The default vector backend is `PgVectorStore` against the landing-zone `competitive-intelligence-platform` Aurora Serverless v2 (pgvector) — a `vector(N)` column with a cosine-distance index, the `vector` extension and table DDL created by the app at bootstrap. Aurora supplies the engine; the app owns the schema. Because the baseline persists, the first crawl after a restart, rollout, or node drain diffs against real history and produces real (usually empty) diffs — not a flood of "everything is new."

The belt-and-suspenders is a **cold-start baseline guard** in the pipeline: when a source's stored `count()` is zero on a crawl, that crawl is treated as baseline seeding — the content is ingested and embedded but no alert fires for that source. That covers the genuine first-ever deploy and any future backend that starts empty, where there's no history to diff against and "everything is new" is an artifact of an empty store rather than a real signal. `MemoryVectorStore` stays available for local dev and tests (it just loses history on restart, which is fine off-cluster).

### Single-writer scheduler (`replicaCount: 1`)

The scheduler runs one global crawl over all sources, and an in-process mutex prevents the scheduler and a `/competitive-intelligence crawl` from racing. Both assume a single writer. The differ does a read-then-replace per source (`deleteByMetadata` + `upsert`), so two pods crawling the same source concurrently would race that replace and could double-fire alerts. The chart pins `replicaCount: 1`; scaling horizontally would require leader election, which isn't in scope. This is documented in the chart and called out here so nobody bumps the replica count expecting throughput.

### Bedrock-default LLM via IRSA, with Anthropic/OpenAI alternates

The default LLM is Bedrock (Claude Sonnet via Converse) and the default embedder is Bedrock Titan v2. Both run on the AWS credential chain, which resolves to **IRSA** on the cluster once the ServiceAccount carries the `eks.amazonaws.com/role-arn` annotation — no API keys anywhere in the repo or image. Anthropic and OpenAI register as alternates only when their key is present; the LLM policy forbids defaulting to a non-Anthropic model, and `bedrock` is the default, so that holds. Inference runs on-account — crawled competitor content is not sent to a third party.

### Converse prompt caching

The analysis system prompt (`ANALYSIS_SYSTEM` in `src/intel/analysis.ts`) is identical on every diff, so the Bedrock Converse request marks a `cachePoint` after the system block. On a steady crawl interval the system prefix is a cache hit every time, cutting input-token cost and latency on the bulk of analysis calls. See § Prompt caching below for the measured ratio.

## Prompt caching

The analysis system prompt is cached via a Converse `cachePoint` marker placed after the system block (and after any stable context prefix). Because that prefix is byte-identical across every diff analyzed within the cache TTL, the second and subsequent analyses in a crawl batch read the prompt from cache rather than re-billing it as input tokens.

Cache effectiveness is **measured, not assumed**. `BedrockLlmProvider.chat` records token usage from every Converse response as four distinct counters — `bedrock.input_tokens`, `bedrock.output_tokens`, `bedrock.cache_read_tokens`, `bedrock.cache_write_tokens` (exported to Mimir as `competitive_intelligence_bedrock_*_tokens_total`). The cache-hit ratio is `cache_read / (cache_read + cache_write)` over a window — high on a warm radar (the system prompt is reused across every source in a crawl) and zero only on the first analysis after a cache expiry. The Grafana dashboard plots the ratio and the token split; the LLM policy requires both the `cachePoint` marker and a measured ratio, which the metric satisfies.

## Data flow: a single crawl

```
1.  scheduler fires (every CRAWL_INTERVAL_MINUTES) — or /competitive-intelligence crawl, or `npm run crawl`
2.  crawl mutex — already running? skip (single-writer)
3.  crawlAll(sources): per source, guardUrl → fetch (per-host breaker) → cheerio HTML→text
4.  ingestAndDiff(pages): per page →
      a. chunk (recursive split + overlap)
      b. embed chunks (Bedrock Titan, default)
      c. semantic diff: each chunk vs best same-source match (cosine < 0.85 → new)
         → cold-start guard: source count()==0 → baseline (ingest, suppress alerts)
      d. replace history: upsert new chunks → prune stale (deleteByMetadata, keeping new ids)
         — ordered so a mid-write failure can't wipe a source's history
5.  alertEngine.processDiffs(diffs): per diff with changeScore ≥ SIGNIFICANCE_THRESHOLD →
      a. LLM analysis (Bedrock Converse, cached system prompt) → summary + significance + signals
      b. format Block Kit → dispatch to the Slack alert sink (#competitive-intel)
```

Querying is the other entry point, independent of the crawl loop:

```
/competitive-intelligence query <q>  (or `npm run query -- "<q>"`)
  → embed question → vector search (top-K, cosine) → LLM answer over retrieved context → reply
```

The Slack bot runs in Socket Mode (outbound WebSocket, no inbound port) when `SLACK_APP_TOKEN` is set, HTTP mode otherwise. The `/health`+`/readyz` HTTP server runs regardless of transport, so the pod always has a port to probe.

## What this repo deliberately does NOT do

- **Not its own cloud substrate.** It does not provision Aurora, the IRSA role, or Secrets Manager entries. Those are landing-zone (see Boundaries). The chart consumes their outputs.
- **Not a model host.** Bedrock runs Claude and Titan inference outside the cluster, on-account. No self-hosted models.
- **Not a cluster bootstrap.** The EKS cluster, ArgoCD, and the addons it depends on (External Secrets Operator, the observability stack, kube-prometheus-stack) must already exist (eks-gitops).
- **Not the tenant operator.** It declares a `Platform` CR; the `eks-agent-platform` operator reconciles the namespace, ResourceQuota, NetworkPolicy, and AppProject.
- **Not a general web scraper.** It crawls a curated, Zod-validated `sources.json` of competitor pages, SSRF-guarded — not arbitrary user-supplied URLs at request time.

## Boundaries

This repo owns the application — source, chart, Platform CR, gitops entry. Everything underneath it lives in two other repos.

### Substrate → `landing-zone`

`landing-zone/components/aws/competitive-intelligence-platform/` provisions the per-tenant AWS data plane and does not move here:

- Aurora Serverless v2 PostgreSQL with pgvector (the durable vector store)
- The IRSA role the app pods assume — `bedrock:InvokeModel` on the Sonnet inference profile + Titan Embed v2, `secretsmanager:GetSecretValue` scoped to `competitive-intelligence/<env>/*`
- Secrets Manager entries: `competitive-intelligence/<env>/app-secrets` (Slack + optional provider keys) and the Aurora-managed `competitive-intelligence/<env>/db-credentials`

Its `irsa_role_arn` output is the role the app pods assume — plumbed into the chart through the per-env `aws.platformRoleArn` Helm value; the Aurora endpoint feeds `tenantInfra.pgHost/pgPort/pgDatabase`. The chart contains **no inline IAM**; the trust relationship is owned in landing-zone and consumed by reference.

### Cluster addons → `eks-gitops`

The chart assumes these cluster-level capabilities are already installed and reconciled by `eks-gitops`:

- **External Secrets Operator** — backs `externalsecret.yaml` (syncs `competitive-intelligence/<env>/app-secrets` + `db-credentials` from Secrets Manager)
- **observability stack** — the cluster OTel Collector (`otel-collector.observability.svc.cluster.local:4318`) and log forwarder that carry traces/metrics/logs to Grafana Cloud. The app emits OTLP and structured JSON to stderr; there are no per-pod sidecars. The `prometheusrule.yaml` alerts and the `grafana-dashboard.yaml` dashboard load into that stack.
