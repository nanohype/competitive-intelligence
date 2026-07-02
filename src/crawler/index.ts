import type { Source } from './sources.js';
import type { ParsedContent } from './parser.js';
import { fetchPage } from './fetcher.js';
import { parseHtml } from './parser.js';
import { logger, toMessage } from '../logger.js';
import { recordCrawlSource, recordCrawlFailure } from '../metrics.js';

export interface CrawlResult {
  succeeded: ParsedContent[];
  failed: Array<{ source: Source; error: string }>;
}

/** Per-source outcome, shaped to match `display.crawlSourceResult`. */
export type CrawlSourceOutcome = { ok: true; parsed: ParsedContent } | { ok: false; error: string };

export interface CrawlOptions {
  timeoutMs: number;
  userAgent: string;
  /** Invoked per source as it completes — lets callers stream progress. */
  onResult?: (source: Source, outcome: CrawlSourceOutcome) => void;
}

/**
 * Crawl all configured sources, fetch HTML, and parse to structured content.
 * Failures are collected rather than thrown — partial results are always returned.
 */
export async function crawlAll(sources: Source[], options: CrawlOptions): Promise<CrawlResult> {
  const succeeded: ParsedContent[] = [];
  const failed: CrawlResult['failed'] = [];

  // Crawl sequentially to respect rate limits. For high-volume use,
  // add concurrency control with p-limit or a semaphore.
  for (const source of sources) {
    try {
      const result = await fetchPage(source.url, options);
      const parsed = parseHtml(result.html, source, result.fetchedAt);
      succeeded.push(parsed);
      recordCrawlSource('succeeded');
      options.onResult?.(source, { ok: true, parsed });
    } catch (err) {
      const message = toMessage(err);
      logger.warn('crawl failed', { sourceId: source.id, url: source.url, error: message });
      failed.push({ source, error: message });
      recordCrawlSource('failed');
      recordCrawlFailure(source.id);
      options.onResult?.(source, { ok: false, error: message });
    }
  }

  logger.info('crawl complete', {
    total: sources.length,
    succeeded: succeeded.length,
    failed: failed.length,
  });

  return { succeeded, failed };
}
