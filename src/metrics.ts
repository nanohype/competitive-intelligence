/**
 * Application metrics via the OTel Metrics API.
 *
 * Exports OTLP to the cluster OTel Collector (the SDK in `otel.ts` wires the
 * meter provider; the chart points it at
 * `otel-collector.observability.svc.cluster.local:4318` → Grafana Cloud Mimir).
 *
 * Two generic call-site helpers — `timing` (histogram, ms) and `counter`
 * (monotonic counter) — back named convenience wrappers for the hot paths:
 * crawl duration, chunks/diffs processed, alerts fired, Bedrock token counts
 * (by kind: input/output/cache_read/cache_write), and circuit-breaker trips.
 *
 * When no meter provider is registered (tests, CI, or any run with
 * `OTEL_SDK_DISABLED=true`), the OTel API degrades to a no-op. That's
 * intentional: nothing here throws without a backend, so call sites stay
 * unconditional.
 */
import { metrics as otelMetrics, type Counter, type Histogram } from "@opentelemetry/api";

const METER_NAME = "competitive-intelligence";

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

function getCounter(name: string): Counter {
  let c = counters.get(name);
  if (!c) {
    c = otelMetrics.getMeter(METER_NAME).createCounter(name);
    counters.set(name, c);
  }
  return c;
}

function getHistogram(name: string): Histogram {
  let h = histograms.get(name);
  if (!h) {
    h = otelMetrics.getMeter(METER_NAME).createHistogram(name, { unit: "ms" });
    histograms.set(name, h);
  }
  return h;
}

// ─── Generic helpers ───

export function timing(name: string, ms: number, dimensions?: Record<string, string>): void {
  getHistogram(name).record(ms, dimensions);
}

export function counter(name: string, value = 1, dimensions?: Record<string, string>): void {
  getCounter(name).add(value, dimensions);
}

// ─── Named convenience wrappers (hot paths) ───

/** Wall-clock duration of one crawl run, in ms. */
export function recordCrawlDuration(ms: number): void {
  timing("crawl.duration_ms", ms);
}

/** Chunks produced + embedded in a pipeline pass. */
export function recordChunksProcessed(count: number): void {
  counter("chunks.processed", count);
}

/** Diffs evaluated against the vector store in a pipeline pass. */
export function recordDiffsProcessed(count: number): void {
  counter("diffs.processed", count);
}

/** Alerts dispatched to Slack. */
export function recordAlertFired(count = 1): void {
  counter("alerts.fired", count);
}

export type TokenKind = "input" | "output" | "cache_read" | "cache_write";

/** Bedrock token usage, dimensioned by kind so cache effectiveness is visible. */
export function recordBedrockTokens(kind: TokenKind, count: number): void {
  if (count <= 0) return;
  counter("bedrock.tokens", count, { kind });
}

/** A circuit breaker tripping open, dimensioned by breaker name. */
export function recordCircuitBreakerTrip(name: string): void {
  counter("circuit_breaker.trips", 1, { breaker: name });
}
