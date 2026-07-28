import type { AlertEngine } from "./alerts/index.js";
import { type CrawlOptions, crawlAll } from "./crawler/index.js";
import type { Source } from "./crawler/sources.js";
import { logger } from "./logger.js";
import { recordCrawlDuration } from "./metrics.js";
import { ingestAndDiff } from "./pipeline/index.js";
import type { EmbeddingProvider } from "./providers/embeddings.js";
import type { VectorStore } from "./providers/vectors.js";

/** Outcome of a crawl trigger, so callers (the MCP trigger_crawl tool) can report honestly. */
export type CrawlOutcome = "ran" | "skipped";

export interface CrawlRunnerDeps {
  sources: Source[];
  crawlOptions: CrawlOptions;
  embedder: EmbeddingProvider;
  store: VectorStore;
  alertEngine: AlertEngine;
}

/**
 * The push radar's one write path: crawl → ingest + semantic diff → alert.
 *
 * The returned function is the single writer. The scheduler calls it on an
 * interval and the MCP `trigger_crawl` tool calls the same instance, so the
 * mutex here is what makes `replicaCount: 1` a real guarantee rather than a
 * comment — two overlapping runs would embed and upsert the same source
 * concurrently, and the second would diff against a store the first was
 * halfway through rewriting.
 *
 * A skipped run is reported, not swallowed: `trigger_crawl` tells the caller
 * "skipped" instead of implying a crawl happened.
 */
export function createCrawlRunner(deps: CrawlRunnerDeps): () => Promise<CrawlOutcome> {
  const { sources, crawlOptions, embedder, store, alertEngine } = deps;
  let crawlInProgress = false;

  return async function runCrawl(): Promise<CrawlOutcome> {
    if (crawlInProgress) {
      logger.warn("crawl already in progress, skipping");
      return "skipped";
    }

    if (sources.length === 0) {
      logger.warn("no sources configured, skipping crawl");
      return "skipped";
    }

    crawlInProgress = true;
    const startedAt = Date.now();
    try {
      const crawlResult = await crawlAll(sources, crawlOptions);

      if (crawlResult.succeeded.length === 0) {
        logger.warn("all crawls failed, nothing to process");
        return "ran";
      }

      // recordDiffsProcessed / recordAlertFired are emitted inside
      // ingestAndDiff / the alert engine so the CLI path counts them too.
      const pipelineResult = await ingestAndDiff(crawlResult.succeeded, embedder, store);
      await alertEngine.processDiffs(pipelineResult.diffs);
      return "ran";
    } finally {
      // Releasing the mutex belongs in `finally` and nowhere else: a throw from
      // the pipeline that left the flag set would wedge the radar for the life
      // of the pod, and every later run — scheduled or triggered — would come
      // back "skipped" with nothing wrong that a restart wouldn't fix.
      crawlInProgress = false;
      recordCrawlDuration(Date.now() - startedAt);
    }
  };
}
