/**
 * Application metrics via the OTel Metrics API.
 *
 * Exports OTLP to the cluster OTel Collector. The meter provider is installed by
 * the Dockerfile's `--require @opentelemetry/auto-instrumentations-node/register`
 * preload (env-driven); the chart points it at
 * `grafana-agent.monitoring.svc.cluster.local:4318` → AMP.
 *
 * Generic call-site helpers — `timing` (ms histogram), `distribution` (unitless
 * histogram) and `counter` (monotonic counter) — back named convenience wrappers
 * for the hot paths: crawl duration + per-source outcome, chunks/diffs processed,
 * change-score distribution, alerts fired + send failures, pgvector errors,
 * Bedrock token counts (one metric per kind so cache effectiveness is visible),
 * and a circuit-breaker open/closed gauge.
 *
 * Metric names map to the `competitive_intelligence_*` series the chart's Grafana
 * dashboard and PrometheusRule query: an OTel instrument named `crawl.failures`
 * (a counter) arrives in AMP as `competitive_intelligence_crawl_failures_total`
 * after this module's NAMESPACE prefix + the OTLP→Prometheus naming convention
 * are applied. Keep instrument names in sync with the chart.
 *
 * When no meter provider is registered (tests, CI, or any run with
 * `OTEL_SDK_DISABLED=true`), the OTel API degrades to a no-op. That's
 * intentional: nothing here throws without a backend, so call sites stay
 * unconditional.
 */
import {
  metrics as otelMetrics,
  type Counter,
  type Histogram,
  type ObservableGauge,
  type ObservableResult,
} from "@opentelemetry/api";

const METER_NAME = "competitive-intelligence";

// Self-prefix every instrument with the service namespace so the Prometheus
// series are deterministic — `crawl.sources` becomes
// `competitive_intelligence_crawl_sources_total` purely from the instrument name
// (OTLP→Prometheus lowercases dots/dashes to underscores + adds the _total
// suffix), with no dependency on a collector-side namespace rewrite.
const NAMESPACE = "competitive_intelligence";
const qualify = (name: string): string => `${NAMESPACE}.${name}`;

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

function getCounter(name: string): Counter {
  let c = counters.get(name);
  if (!c) {
    c = otelMetrics.getMeter(METER_NAME).createCounter(qualify(name));
    counters.set(name, c);
  }
  return c;
}

function getHistogram(name: string, unit: string, boundaries?: number[]): Histogram {
  let h = histograms.get(name);
  if (!h) {
    const opts: { unit: string; advice?: { explicitBucketBoundaries: number[] } } = { unit };
    if (boundaries) opts.advice = { explicitBucketBoundaries: boundaries };
    h = otelMetrics.getMeter(METER_NAME).createHistogram(qualify(name), opts);
    histograms.set(name, h);
  }
  return h;
}

// ─── Generic helpers ───

export function timing(name: string, ms: number, dimensions?: Record<string, string>): void {
  getHistogram(name, "ms").record(ms, dimensions);
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
  getHistogram(name, "1", boundaries).record(value, dimensions);
}

export function counter(name: string, value = 1, dimensions?: Record<string, string>): void {
  getCounter(name).add(value, dimensions);
}

// ─── Named convenience wrappers (hot paths) ───

/** Wall-clock duration of one crawl run, in ms. */
export function recordCrawlDuration(ms: number): void {
  timing("crawl.duration_ms", ms);
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

// ─── Circuit-breaker open gauge ───
// The CircuitBreakerOpen alert + dashboard panel query a 1/0 gauge labelled by
// `target`. An ObservableGauge reports current per-breaker state on each scrape;
// breakers call setCircuitBreakerOpen on every trip/reset.

const breakerOpen = new Map<string, number>();
let breakerGauge: ObservableGauge | undefined;

export function setCircuitBreakerOpen(name: string, open: boolean): void {
  breakerOpen.set(name, open ? 1 : 0);
  if (!breakerGauge) {
    breakerGauge = otelMetrics
      .getMeter(METER_NAME)
      .createObservableGauge(qualify("circuit_breaker.open"));
    breakerGauge.addCallback((result: ObservableResult) => {
      for (const [target, value] of breakerOpen) {
        result.observe(value, { target });
      }
    });
  }
}
