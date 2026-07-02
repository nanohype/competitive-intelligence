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
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

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

  // SSRF guard: scheme allowlist + private-IP / loopback / metadata block.
  // Runs before circuit-breaker bookkeeping so rejected hosts never get
  // tracked.
  await guardUrl(url);

  return breakerFor(url).exec(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      logger.debug('fetching', { url });

      // `redirect: "manual"` means a 3xx surfaces here as `response.ok ===
      // false` rather than silently routing to a destination that wasn't
      // guard-checked. Operators who need to follow redirects should
      // promote each redirect target to a first-class source.
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': options.userAgent,
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        throw new Error(`HTTP ${response.status} redirect from ${url} (follow disabled)`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
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

      logger.info('fetched', { url, status: response.status, bytes: html.length });

      return {
        url,
        html,
        statusCode: response.status,
        fetchedAt: new Date(),
        headers,
      };
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
