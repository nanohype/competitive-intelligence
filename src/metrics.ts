/**
 * Application metrics via the OTel Metrics API.
 *
 * Exports OTLP to the cluster's Grafana Alloy collector. The meter provider is
 * installed by the Dockerfile's
 * `--require @opentelemetry/auto-instrumentations-node/register`
 * preload (env-driven); the chart points it at
 * `alloy.monitoring.svc.cluster.local:4318` → AMP.
 *
 * The lazy-instrument core (namespace qualification, per-name caching, no-op
 * degradation without a provider) is the vendored `@nanohype/runtime` metrics
 * module; this file is the app surface over it: the generic `timing` /
 * `distribution` / `counter` helpers plus named convenience wrappers for the
 * hot paths — crawl duration + per-source outcome, chunks/diffs processed,
 * change-score distribution, alerts fired + send failures, pgvector errors,
 * Bedrock token counts (one metric per kind so cache effectiveness is
 * visible), and the circuit-breaker open/closed gauge.
 *
 * Metric names map to the `competitive_intelligence_*` series the chart's
 * Grafana dashboard and PrometheusRule query — an instrument named
 * `crawl.failures` arrives in AMP as
 * `competitive_intelligence_crawl_failures_total`. Keep instrument names in
 * sync with the chart.
 */
import { createMetrics } from "./vendor/runtime/metrics.js";

const metrics = createMetrics({
  meterName: "competitive-intelligence",
  namespace: "competitive_intelligence",
});

// ─── Generic helpers ───

export function timing(name: string, ms: number, dimensions?: Record<string, string>): void {
  metrics.timing(name, ms, dimensions);
}

/**
 * Record a duration in SECONDS. `boundaries` is not optional in practice for
 * anything that can run past ten seconds: OTel's default bucket edges top out at
 * 10000, which is fine as milliseconds and wrong as seconds, and
 * `histogram_quantile` cannot return a value above the highest finite edge.
 */
export function duration(
  name: string,
  seconds: number,
  dimensions?: Record<string, string>,
  boundaries?: readonly number[],
): void {
  metrics.duration(
    name,
    seconds,
    dimensions,
    boundaries ? { boundaries: [...boundaries] } : undefined,
  );
}

/**
 * Record a unitless value into a histogram. `boundaries` sets explicit bucket
 * edges — required for 0–1 ratios, which otherwise inherit OTel's default
 * ms-scale buckets ([0,5,...]) and collapse every value into the first bucket.
 */
export function distribution(
  name: string,
  value: number,
  dimensions?: Record<string, string>,
  boundaries?: number[],
): void {
  metrics.distribution(name, value, dimensions, boundaries ? { boundaries } : undefined);
}

export function counter(name: string, value = 1, dimensions?: Record<string, string>): void {
  metrics.counter(name, value, dimensions);
}

// ─── Named convenience wrappers (hot paths) ───

/**
 * Bucket edges for a crawl run, in seconds. A full sweep is minutes, not
 * milliseconds, so the OTel defaults would put every observation in the overflow
 * bucket and make any quantile over this series meaningless.
 */
export const CRAWL_DURATION_BUCKETS = [10, 30, 60, 120, 300, 600, 1200] as const;

/** Wall-clock duration of one crawl run, in seconds. */
export function recordCrawlDuration(seconds: number): void {
  duration("crawl.duration_seconds", seconds, undefined, CRAWL_DURATION_BUCKETS);
}

/** One crawled source, dimensioned by outcome (succeeded | failed). */
export function recordCrawlSource(outcome: "succeeded" | "failed"): void {
  counter("crawl.sources", 1, { outcome });
}

/** A crawl failure for one source — backs the CrawlFailureSpike alert. */
export function recordCrawlFailure(sourceId: string): void {
  counter("crawl.failures", 1, { sourceId });
}

/** Chunks produced + embedded in a pipeline pass. */
export function recordChunksProcessed(count: number): void {
  counter("chunks.processed", count);
}

/** Diffs evaluated against the vector store in a pipeline pass. */
export function recordDiffsProcessed(count: number): void {
  counter("diffs.processed", count);
}

/** The change score of one non-baseline diff (0–1), as a distribution. */
export function recordChangeScore(score: number): void {
  distribution(
    "change_score",
    score,
    undefined,
    [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  );
}

/** Alerts dispatched to Slack. */
export function recordAlertFired(count = 1): void {
  counter("alerts.fired", count);
}

/** A failed Slack alert send — backs the AlertSendFailure alert. */
export function recordAlertSendFailure(sourceId: string): void {
  counter("alert.send_failures", 1, { sourceId });
}

/** A pgvector store error — backs the PgVectorUnreachable alert. */
export function recordPgVectorError(): void {
  counter("pgvector.errors");
}

export type TokenKind = "input" | "output" | "cache_read" | "cache_write";

/**
 * Bedrock token usage. Each kind is its own metric name
 * (`bedrock.input_tokens` → `competitive_intelligence_bedrock_input_tokens_total`)
 * so the dashboard's per-kind panels — including cache effectiveness — render.
 */
export function recordBedrockTokens(kind: TokenKind, count: number): void {
  if (count <= 0) return;
  counter(`bedrock.${kind}_tokens`, count);
}

/**
 * The CircuitBreakerOpen alert + dashboard panel query a 1/0 gauge labelled
 * by `target`; breakers call this on every trip/recovery.
 */
export function setCircuitBreakerOpen(name: string, open: boolean): void {
  metrics.setObservable("circuit_breaker.open", open ? 1 : 0, { target: name });
}
