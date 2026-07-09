import { createBreaker, type CircuitBreaker } from '../resilience/circuit-breaker.js';
import { logger } from '../logger.js';
import { guardUrl } from './url-guard.js';

export interface FetchResult {
  url: string;
  html: string;
  statusCode: number;
  fetchedAt: Date;
  headers: Record<string, string>;
}

export interface FetchOptions {
  readonly timeoutMs: number;
  readonly userAgent: string;
  /** Hard cap on the response body in bytes. @default 10 MiB */
  readonly maxBytes?: number;
  /** Max redirect hops to follow (each SSRF-guarded). @default 5 */
  readonly maxRedirects?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

// Per-host circuit breakers so one flaky site doesn't block all sources.
const breakers = new Map<string, CircuitBreaker>();

function breakerFor(url: string): CircuitBreaker {
  const host = new URL(url).hostname;
  let breaker = breakers.get(host);
  if (!breaker) {
    // 3 failures within the 5-minute default window trips the host (a
    // hard-down host fails 3 sequential fetches well inside one window);
    // 2-minute cooldown before the half-open probe.
    breaker = createBreaker(`http:${host}`, {
      failureThreshold: 3,
      halfOpenAfterMs: 120_000,
    });
    breakers.set(host, breaker);
  }
  return breaker;
}

export async function fetchPage(url: string, options: FetchOptions): Promise<FetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  // SSRF guard: scheme allowlist + private-IP / loopback / metadata block.
  // Runs before circuit-breaker bookkeeping so rejected hosts never get
  // tracked.
  await guardUrl(url);

  return breakerFor(url).exec(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      // Follow redirects manually so every hop is SSRF-guarded before we
      // fetch it — `redirect: "follow"` would chase a Location header to a
      // private/metadata address without a guard check. Competitor blogs and
      // changelogs routinely 30x (host canonicalisation, trailing slashes), so
      // dropping redirects silently starves the index; following them, guarded
      // and bounded, is both safe and necessary. The timeout spans the whole
      // chain and the breaker is keyed on the original host.
      let current = url;
      for (let hop = 0; ; hop++) {
        logger.debug('fetching', { url: current });

        const response = await fetch(current, {
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'User-Agent': options.userAgent,
            Accept: 'text/html,application/xhtml+xml',
          },
        });

        if (response.status >= 300 && response.status < 400) {
          if (hop >= maxRedirects) {
            throw new Error(`too many redirects (>${maxRedirects}) starting at ${url}`);
          }
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`HTTP ${response.status} from ${current} with no Location header`);
          }
          // Resolve a relative Location against the current URL, then SSRF-guard
          // the target BEFORE following it — this is what makes redirect
          // following safe. A redirect to a blocked address throws here.
          const next = new URL(location, current).toString();
          await guardUrl(next);
          logger.debug('redirect', { from: current, to: next, status: response.status });
          current = next;
          continue;
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} for ${current}`);
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && Number(contentLength) > maxBytes) {
          throw new Error(`response too large: ${contentLength} bytes (max ${maxBytes})`);
        }

        const html = await readBodyCapped(response, maxBytes);
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headers[k] = v;
        });

        // `url` is the FINAL location after redirects, so downstream metadata
        // records where the content actually came from.
        logger.info('fetched', { url: current, status: response.status, bytes: html.length });

        return {
          url: current,
          html,
          statusCode: response.status,
          fetchedAt: new Date(),
          headers,
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  });
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}
