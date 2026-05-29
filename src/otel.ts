/**
 * OpenTelemetry bootstrap.
 *
 * `startTelemetry()` initializes the OTel Node SDK — OTLP http/protobuf
 * trace + metric exporters plus the Node auto-instrumentations
 * (http/fetch/aws-sdk/pg/etc.). Call it FIRST in `main()`, before any
 * client is constructed, so the instrumentation hooks are in place before
 * the modules they patch get used.
 *
 * The OTLP target comes from `OTEL_EXPORTER_OTLP_ENDPOINT` (the chart points
 * it at the cluster collector, `otel-collector.observability.svc.cluster.local:4318`).
 * Resource attributes — `service.name`, `deployment.environment`,
 * `agents.tenant`, `agents.platform` — ride in via `OTEL_RESOURCE_ATTRIBUTES`,
 * which the SDK reads automatically; we don't hardcode them here. The only
 * default we set is a sane `service.name` so spans are attributable even
 * without the chart env (local runs). Anything in `OTEL_RESOURCE_ATTRIBUTES`
 * wins over the default.
 *
 * `OTEL_SDK_DISABLED=true` short-circuits the whole thing — used by tests,
 * CI, and local runs where no collector is reachable. Traces/metrics simply
 * don't export; the OTel API degrades to a no-op (see `metrics.ts`).
 */
import { NodeSDK, metrics as nodeMetrics } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { logger } from "./logger.js";

let sdk: NodeSDK | undefined;

/**
 * Initialize the OTel SDK. Idempotent — a second call is a no-op. Returns
 * the SDK instance (or `undefined` when disabled) so callers can drive
 * `shutdown()` on graceful exit.
 */
export function startTelemetry(): NodeSDK | undefined {
  if (process.env.OTEL_SDK_DISABLED === "true") {
    return undefined;
  }
  if (sdk) {
    return sdk;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

  sdk = new NodeSDK({
    // service.name default only; deployment.environment / agents.tenant /
    // agents.platform come from OTEL_RESOURCE_ATTRIBUTES, merged by the SDK.
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "competitive-intelligence",
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new nodeMetrics.PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are noise for a long-lived crawler — drop them.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  logger.info("telemetry started", { endpoint });
  return sdk;
}

/**
 * Flush + stop the SDK. Safe to call when telemetry was never started.
 */
export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // best-effort on shutdown — never block process exit on a flush failure
  } finally {
    sdk = undefined;
  }
}
