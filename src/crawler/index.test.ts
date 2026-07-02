import { describe, it, expect, vi } from 'vitest';
import { crawlAll, type CrawlOptions, type CrawlSourceOutcome } from './index.js';
import type { Source } from './sources.js';

const source = (id: string): Source => ({
  id,
  competitor: 'acme',
  url: `https://example.com/${id}`,
  type: 'pricing',
});

const page = (html: string) =>
  Promise.resolve({
    html,
    fetchedAt: new Date('2026-07-01'),
    url: 'https://example.com',
    statusCode: 200,
    headers: {},
  });

const options = (overrides: Partial<CrawlOptions> = {}): CrawlOptions => ({
  timeoutMs: 1000,
  userAgent: 'test-agent',
  ...overrides,
});

describe('crawlAll', () => {
  it('collects parsed content for every source that fetches', async () => {
    const fetchPageImpl = vi.fn(() => page('<html><title>t</title><body><p>hi</p></body></html>'));

    const result = await crawlAll([source('a'), source('b')], options({ fetchPageImpl }));

    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.succeeded.map((p) => p.sourceId)).toEqual(['a', 'b']);
    expect(fetchPageImpl).toHaveBeenCalledTimes(2);
  });

  it('degrades a failing source to the failed list and keeps crawling', async () => {
    const fetchPageImpl = vi.fn((url: string) =>
      url.endsWith('/bad')
        ? Promise.reject(new Error('ECONNRESET'))
        : page('<html><body><p>ok</p></body></html>'),
    );

    const result = await crawlAll(
      [source('good'), source('bad'), source('also-good')],
      options({ fetchPageImpl }),
    );

    expect(result.succeeded.map((p) => p.sourceId)).toEqual(['good', 'also-good']);
    expect(result.failed).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ id: 'bad' }) }),
    ]);
    expect(result.failed[0].error).toBe('ECONNRESET');
  });

  it('streams per-source outcomes through onResult in crawl order', async () => {
    const outcomes: Array<{ id: string; ok: boolean }> = [];
    const onResult = (s: Source, o: CrawlSourceOutcome) => outcomes.push({ id: s.id, ok: o.ok });
    const fetchPageImpl = vi.fn((url: string) =>
      url.endsWith('/down')
        ? Promise.reject(new Error('boom'))
        : page('<html><body><p>x</p></body></html>'),
    );

    await crawlAll([source('up'), source('down')], options({ fetchPageImpl, onResult }));

    expect(outcomes).toEqual([
      { id: 'up', ok: true },
      { id: 'down', ok: false },
    ]);
  });

  it('returns empty results for an empty source list', async () => {
    const fetchPageImpl = vi.fn(() => page(''));
    const result = await crawlAll([], options({ fetchPageImpl }));
    expect(result).toEqual({ succeeded: [], failed: [] });
    expect(fetchPageImpl).not.toHaveBeenCalled();
  });
});
