import * as cheerio from "cheerio";
import type { Source } from "./sources.js";

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
  $("script, style, noscript, iframe, svg, img, video, audio").remove();

  // Remove source-specific exclusions
  if (source.selectors?.exclude) {
    for (const sel of source.selectors.exclude) {
      $(sel).remove();
    }
  }

  // Select content scope
  const scope = source.selectors?.content ? $(source.selectors.content) : $("body");

  const title = $("title").text().trim() || $("h1").first().text().trim();

  // Extract text, collapsing whitespace
  const text = scope.text().replace(/\s+/g, " ").trim();

  // Extract links for potential follow-up crawling
  const links: string[] = [];
  scope.find("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      try {
        const resolved = new URL(href, source.url).toString();
        links.push(resolved);
      } catch {
        // skip malformed URLs
      }
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
