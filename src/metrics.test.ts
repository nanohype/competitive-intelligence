import {
  AggregationTemporality,
  type DataPoint,
  type Histogram as HistogramPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { metrics as otelMetrics } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CRAWL_DURATION_BUCKETS, duration, recordCrawlDuration } from "./metrics.js";

/**
 * Durations are seconds, and a crawl declares bucket edges wide enough to hold
 * one.
 *
 * The edges are the part worth a test. A crawl sweep is minutes; OTel's default
 * bucket edges top out at 10000, and `histogram_quantile` cannot return a value
 * above the highest finite edge — so with the defaults every real observation
 * lands in the overflow bucket and the three dashboard panels render a constant
 * rather than a latency.
 */
let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

// One provider for the file. The runtime caches an instrument per name on first
// use, so swapping providers between tests would leave later calls bound to a
// disposed one — and each test therefore uses its own metric name.
beforeAll(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
  });
  otelMetrics.setGlobalMeterProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  otelMetrics.disable();
});

async function collect(): Promise<
  Record<string, { unit: string; point: DataPoint<HistogramPoint> }>
> {
  await provider.forceFlush();
  const out: Record<string, { unit: string; point: DataPoint<HistogramPoint> }> = {};
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        out[m.descriptor.name] = {
          unit: m.descriptor.unit,
          point: m.dataPoints[0] as DataPoint<HistogramPoint>,
        };
      }
    }
  }
  return out;
}

describe("duration", () => {
  it("records seconds, not milliseconds", async () => {
    duration("unit_probe.duration_seconds", 1.5);
    const got = await collect();
    const m = got["competitive_intelligence.unit_probe.duration_seconds"];
    expect(m).toBeDefined();
    expect(m.unit).toBe("s");
    expect(m.point.value.sum).toBe(1.5);
  });

  it("applies explicit bucket edges when given them", async () => {
    duration("edges_probe.duration_seconds", 42, undefined, [10, 30, 60]);
    const got = await collect();
    const m = got["competitive_intelligence.edges_probe.duration_seconds"];
    expect(m.point.value.buckets.boundaries).toEqual([10, 30, 60]);
  });
});

describe("recordCrawlDuration", () => {
  it("declares edges that reach past a real sweep", async () => {
    // 400 s is an ordinary sweep and lands in (300,600]. Under OTel's defaults
    // it would sit in the overflow bucket above 10000, which no quantile can
    // return — the whole reason these edges are declared.
    recordCrawlDuration(400);
    const got = await collect();
    const m = got["competitive_intelligence.crawl.duration_seconds"];
    expect(m).toBeDefined();
    expect(m.unit).toBe("s");
    expect(m.point.value.buckets.boundaries).toEqual([...CRAWL_DURATION_BUCKETS]);

    const idx = m.point.value.buckets.counts.findIndex((c) => c > 0);
    const top = CRAWL_DURATION_BUCKETS[CRAWL_DURATION_BUCKETS.length - 1];
    expect(idx, `a ${400}s sweep must not land in the overflow bucket above ${top}s`).toBeLessThan(
      CRAWL_DURATION_BUCKETS.length,
    );
  });

  it("names the series in base units", async () => {
    recordCrawlDuration(1);
    const got = await collect();
    expect(Object.keys(got)).toContain("competitive_intelligence.crawl.duration_seconds");
    expect(Object.keys(got)).not.toContain("competitive_intelligence.crawl.duration_ms");
  });
});
