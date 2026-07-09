import http from 'node:http';
import { loadConfig } from './config.js';
import { logger, setLogLevel, toMessage } from './logger.js';
import { bootstrapLlm } from './providers/llm.js';
import { bootstrapEmbeddings } from './providers/embeddings.js';
import { bootstrapVectorStore, type VectorStore } from './providers/vectors.js';
import { loadSourcesFromFile } from './crawler/sources.js';
import { crawlAll } from './crawler/index.js';
import { ingestAndDiff } from './pipeline/index.js';
import { createIntelEngine } from './intel/index.js';
import { createAlertEngine, type AlertSink } from './alerts/index.js';
import { createSlackSink } from './alerts/slack-sink.js';
import { createMcpHttpServer } from './mcp/server.js';
import { createOAuthProtection, type OAuthProtection } from './mcp/oauth.js';
import { createScheduler } from './scheduler/index.js';
import { recordCrawlDuration } from './metrics.js';

/** Outcome of a crawl trigger, so callers (the MCP trigger_crawl tool) can report honestly. */
export type CrawlOutcome = 'ran' | 'skipped';

/** Split the optional MCP_AUTH_SCOPES env (space- or comma-delimited) into a scope list. */
function parseScopes(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const scopes = raw.split(/[\s,]+/).filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

/**
 * Tiny liveness/readiness server.
 *
 * Bound on `config.port`, separate from the MCP server (`config.mcpPort`).
 * `/health` is pure liveness (process is up). `/readyz` is readiness — it
 * resolves `store.count()`; a reachable vector store → 200, anything else →
 * 503 so the pod is pulled out of rotation (and rollouts wait) until the
 * backend recovers.
 */
function createHealthServer(store: VectorStore): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'GET' && url === '/readyz') {
      store
        .count()
        .then(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ready' }));
        })
        .catch((err: unknown) => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'unready',
              error: toMessage(err),
            }),
          );
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
  });
}

async function main(): Promise<void> {
  // Telemetry is initialized by the Dockerfile's
  // `--require @opentelemetry/auto-instrumentations-node/register` preload — it
  // must load before any instrumented module is imported, which a call here
  // (after the import graph is already resolved) cannot guarantee. All OTel
  // config is env-driven (see the chart's OTEL_* env). Locally, telemetry is
  // simply absent and the OTel API degrades to a no-op.
  logger.info('competitive-intelligence starting');

  // ─── Config ───
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // ─── Providers ───
  const llm = bootstrapLlm(config);
  const embedder = bootstrapEmbeddings(config);
  const store = bootstrapVectorStore(config);

  // ─── Sources ───
  const sources = loadSourcesFromFile('sources.json');

  // ─── Core crawl+process function ───
  // Mutex prevents overlapping runs from scheduler + MCP trigger_crawl racing.
  let crawlInProgress = false;

  async function runCrawl(): Promise<CrawlOutcome> {
    if (crawlInProgress) {
      logger.warn('crawl already in progress, skipping');
      return 'skipped';
    }

    if (sources.length === 0) {
      logger.warn('no sources configured, skipping crawl');
      return 'skipped';
    }

    crawlInProgress = true;
    const startedAt = Date.now();
    try {
      const crawlResult = await crawlAll(sources, {
        timeoutMs: config.crawlTimeoutMs,
        userAgent: config.userAgent,
      });

      if (crawlResult.succeeded.length === 0) {
        logger.warn('all crawls failed, nothing to process');
        return 'ran';
      }

      // recordDiffsProcessed / recordAlertFired are emitted inside
      // ingestAndDiff / the alert engine so the CLI path counts them too.
      const pipelineResult = await ingestAndDiff(crawlResult.succeeded, embedder, store);
      await alertEngine.processDiffs(pipelineResult.diffs);
      return 'ran';
    } finally {
      crawlInProgress = false;
      recordCrawlDuration(Date.now() - startedAt);
    }
  }

  // ─── Intel engine ───
  const intel = createIntelEngine(embedder, store, llm);

  // ─── Outbound alert sink ───
  // The radar posts its deterministic Block Kit alerts to Slack via the
  // outbound web-api sink (circuit-breakered, 10s timeout). Absent bot token →
  // alerts log only (CLI / local dev).
  const alertSink: AlertSink = config.slackBotToken
    ? createSlackSink(config.slackBotToken)
    : {
        async send(channel: string, _message) {
          logger.info('alert (no slack configured)', { channel });
        },
      };

  const alertEngine = createAlertEngine(llm, alertSink, config);

  // ─── MCP OAuth resource-server protection (optional) ───
  // When MCP_AUTH=workos the MCP port becomes an OAuth 2.1 resource server that
  // requires a WorkOS AuthKit bearer token bound to this server's canonical URI
  // (RFC 8707 audience). Unset → open mode: the mcp-tunnel + NetworkPolicy are
  // the only guard, exactly as before. WorkOS is the authorization server,
  // configured in its dashboard; this is only the resource-server half.
  let oauth: OAuthProtection | undefined;
  if (config.mcpAuth === 'workos' && config.workosAuthkitIssuer && config.mcpPublicUrl) {
    oauth = createOAuthProtection({
      issuer: config.workosAuthkitIssuer,
      resource: config.mcpPublicUrl,
      requiredScopes: parseScopes(config.mcpAuthScopes),
    });
    logger.info('mcp oauth enabled (workos resource server)', {
      issuer: config.workosAuthkitIssuer,
      resource: config.mcpPublicUrl,
    });
  }

  // ─── MCP server (the pull/query surface) ───
  // Streamable-HTTP MCP server on its own port. `trigger_crawl` calls the
  // in-process single-writer `runCrawl` directly — no cross-pod RPC — because
  // the scheduler, sink, and MCP server share this one process (replicaCount:
  // 1). The mcp-tunnel is the only ingress (chart NetworkPolicy).
  const mcpServer = createMcpHttpServer({ intel, runCrawl, sources }, oauth);

  // ─── Scheduler ───
  const scheduler = createScheduler([
    {
      name: 'crawl',
      intervalMs: config.crawlIntervalMinutes * 60 * 1000,
      // Discard the outcome — the scheduler job is fire-and-forget (void).
      fn: async () => {
        await runCrawl();
      },
    },
  ]);

  // ─── Health server ───
  const healthServer = createHealthServer(store);
  await new Promise<void>((resolve) => healthServer.listen(config.port, resolve));
  logger.info('health server listening', { port: config.port });

  // ─── MCP server ───
  await mcpServer.listen(config.mcpPort);
  logger.info('mcp server listening', { port: config.mcpPort });

  // ─── Start ───
  scheduler.start();

  // Run initial crawl — best-effort seeding. A failure here (the embedding
  // backend unreachable at boot, say) must not crash a long-running service
  // that can still serve MCP queries and will re-attempt on the next scheduled
  // interval; the scheduler guards its own runs the same way.
  logger.info('running initial crawl');
  try {
    await runCrawl();
  } catch (err) {
    logger.error('initial crawl failed; continuing and will retry on the schedule', {
      error: toMessage(err),
    });
  }

  logger.info('competitive-intelligence running', {
    sources: sources.length,
    crawlInterval: `${config.crawlIntervalMinutes}m`,
    vectorProvider: config.vectorProvider,
    llmProvider: config.llmProvider,
    alertSink: config.slackBotToken ? 'slack' : 'log',
    port: config.port,
    mcpPort: config.mcpPort,
    mcpAuth: oauth ? 'workos' : 'open',
  });

  // ─── Graceful shutdown ───
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    scheduler.stop();
    await mcpServer.close();
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    // The auto-instrumentations preload registers its own SIGTERM/beforeExit
    // flush, so there is no programmatic SDK to shut down here.
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('fatal', { error: toMessage(err) });
  process.exit(1);
});
