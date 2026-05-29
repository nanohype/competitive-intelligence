import type { Source } from "./sources.js";
import type { ParsedContent } from "./parser.js";
import { fetchPage } from "./fetcher.js";
import { parseHtml } from "./parser.js";
import { logger } from "../logger.js";

export interface CrawlResult {
  succeeded: ParsedContent[];
  failed: Array<{ source: Source; error: string }>;
}

/**
 * Crawl all configured sources, fetch HTML, and parse to structured content.
 * Failures are collected rather than thrown — partial results are always returned.
 */
export async function crawlAll(
  sources: Source[],
  options: { timeoutMs: number; userAgent: string },
): Promise<CrawlResult> {
  const succeeded: ParsedContent[] = [];
  const failed: CrawlResult["failed"] = [];

  // Crawl sequentially to respect rate limits. For high-volume use,
  // add concurrency control with p-limit or a semaphore.
  for (const source of sources) {
    try {
      const result = await fetchPage(source.url, options);
      const parsed = parseHtml(result.html, source, result.fetchedAt);
      succeeded.push(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("crawl failed", { sourceId: source.id, url: source.url, error: message });
      failed.push({ source, error: message });
    }
  }

  logger.info("crawl complete", {
    total: sources.length,
    succeeded: succeeded.length,
    failed: failed.length,
  });

  return { succeeded, failed };
}
