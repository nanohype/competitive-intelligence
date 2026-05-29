import { startTelemetry, stopTelemetry } from "./otel.js";
import http from "node:http";
import { loadConfig } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import { bootstrapLlm } from "./providers/llm.js";
import { bootstrapEmbeddings } from "./providers/embeddings.js";
import { bootstrapVectorStore, type VectorStore } from "./providers/vectors.js";
import { loadSourcesFromFile } from "./crawler/sources.js";
import { crawlAll } from "./crawler/index.js";
import { ingestAndDiff } from "./pipeline/index.js";
import { createIntelEngine } from "./intel/index.js";
import { createAlertEngine, type AlertSink } from "./alerts/index.js";
import { createSlackBot } from "./slack/index.js";
import { createScheduler } from "./scheduler/index.js";
import { recordCrawlDuration, recordDiffsProcessed, recordAlertFired } from "./metrics.js";

/**
 * Tiny liveness/readiness server.
 *
 * Bound unconditionally to `config.port` regardless of Slack transport:
 * Socket Mode opens an outbound WebSocket and binds no port, so without this
 * the pod has nothing for the kubelet to probe. `/health` is pure liveness
 * (process is up). `/readyz` is readiness — it resolves `store.count()`; a
 * reachable vector store → 200, anything else → 503 so the pod is pulled out
 * of rotation (and rollouts wait) until the backend recovers.
 */
function createHealthServer(store: VectorStore): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && url === "/readyz") {
      store
        .count()
        .then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ready" }));
        })
        .catch((err: unknown) => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              status: "unready",
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });
}

async function main(): Promise<void> {
  // Start telemetry FIRST so auto-instrumentation patches http/fetch/aws-sdk
  // before any client below is constructed.
  startTelemetry();

  logger.info("competitive-intelligence starting");

  // ─── Config ───
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // ─── Providers ───
  const llm = bootstrapLlm(config);
  const embedder = bootstrapEmbeddings(config);
  const store = bootstrapVectorStore(config);

  // ─── Sources ───
  const sources = loadSourcesFromFile("sources.json");

  // ─── Core crawl+process function ───
  // Mutex prevents overlapping runs from scheduler + slash command racing.
  let crawlInProgress = false;

  async function runCrawl(): Promise<void> {
    if (crawlInProgress) {
      logger.warn("crawl already in progress, skipping");
      return;
    }

    if (sources.length === 0) {
      logger.warn("no sources configured, skipping crawl");
      return;
    }

    crawlInProgress = true;
    const startedAt = Date.now();
    try {
      const crawlResult = await crawlAll(sources, {
        timeoutMs: config.crawlTimeoutMs,
        userAgent: config.userAgent,
      });

      if (crawlResult.succeeded.length === 0) {
        logger.warn("all crawls failed, nothing to process");
        return;
      }

      const pipelineResult = await ingestAndDiff(crawlResult.succeeded, embedder, store);
      recordDiffsProcessed(pipelineResult.diffs.length);

      const analyses = await alertEngine.processDiffs(pipelineResult.diffs);
      if (analyses.length > 0) recordAlertFired(analyses.length);
    } finally {
      crawlInProgress = false;
      recordCrawlDuration(Date.now() - startedAt);
    }
  }

  // ─── Intel engine ───
  const intel = createIntelEngine(embedder, store, llm);

  // ─── Slack bot + alert sink ───
  let alertSink: AlertSink = {
    async send(channel: string, _message) {
      logger.info("alert (no slack configured)", { channel });
    },
  };

  let slackBot: Awaited<ReturnType<typeof createSlackBot>> | null = null;

  if (config.slackBotToken) {
    slackBot = createSlackBot(config, intel, runCrawl);
    alertSink = slackBot.sink;
  }

  const alertEngine = createAlertEngine(llm, alertSink, config);

  // ─── Scheduler ───
  const scheduler = createScheduler([
    {
      name: "crawl",
      intervalMs: config.crawlIntervalMinutes * 60 * 1000,
      fn: runCrawl,
    },
  ]);

  // ─── Health server ───
  // Always bound — k8s probes need a port even in Socket Mode (no inbound HTTP product surface).
  const healthServer = createHealthServer(store);
  await new Promise<void>((resolve) => healthServer.listen(config.port, resolve));
  logger.info("health server listening", { port: config.port });

  // ─── Start ───
  scheduler.start();

  if (slackBot) {
    await slackBot.start();
  }

  // Run initial crawl
  logger.info("running initial crawl");
  await runCrawl();

  logger.info("competitive-intelligence running", {
    sources: sources.length,
    crawlInterval: `${config.crawlIntervalMinutes}m`,
    vectorProvider: config.vectorProvider,
    llmProvider: config.llmProvider,
    slackEnabled: !!config.slackBotToken,
    port: config.port,
  });

  // ─── Graceful shutdown ───
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    scheduler.stop();
    if (slackBot) await slackBot.stop();
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await stopTelemetry();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
