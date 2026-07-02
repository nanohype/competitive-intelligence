import * as cheerio from 'cheerio';
import type { Source } from './sources.js';

export interface ParsedContent {
  sourceId: string;
  competitor: string;
  type: string;
  url: string;
  title: string;
  text: string;
  links: string[];
  fetchedAt: Date;
}

/**
 * Extract structured text content from raw HTML using source-specific selectors.
 * Strips navigation, scripts, styles, and other noise.
 */
export function parseHtml(html: string, source: Source, fetchedAt: Date): ParsedContent {
  const $ = cheerio.load(html);

  // Remove noise elements universally
  $('script, style, noscript, iframe, svg, img, video, audio').remove();

  // Remove source-specific exclusions
  if (source.selectors?.exclude) {
    for (const sel of source.selectors.exclude) {
      $(sel).remove();
    }
  }

  // Select content scope
  const scope = source.selectors?.content ? $(source.selectors.content) : $('body');

  const title = $('title').text().trim() || $('h1').first().text().trim();

  // Extract text, collapsing whitespace
  const text = scope.text().replace(/\s+/g, ' ').trim();

  // Extract links for potential follow-up crawling
  const links: string[] = [];
  scope.find('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#')) return;
    try {
      const resolved = new URL(href, source.url);
      // Allowlist safe schemes on the RESOLVED url. Blocklisting `javascript:`
      // alone is incomplete — `data:`, `vbscript:`, mixed-case (`JavaScript:`),
      // and whitespace-padded variants all slip a substring check; resolving
      // first and gating on the normalized protocol closes all of them.
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        links.push(resolved.toString());
      }
    } catch {
      // skip malformed URLs
    }
  });

  return {
    sourceId: source.id,
    competitor: source.competitor,
    type: source.type,
    url: source.url,
    title,
    text,
    links: [...new Set(links)],
    fetchedAt,
  };
}
