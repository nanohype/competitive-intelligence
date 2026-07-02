import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPage, type FetchOptions } from './fetcher.js';
import { CircuitOpenError } from '../resilience/circuit-breaker.js';
import { UrlGuardError } from './url-guard.js';

// Breaker-trip behavior of the fetch pipeline under the vendored
// sliding-window breaker: per-host trip on failure density, fast-fail while
// open, window decay, and half-open recovery after the cooldown.
//
// The per-host breaker map is module-global, so each test uses its own host.
// Hosts are TEST-NET-3 (203.0.113.0/24) IP literals: public-range addresses
// the SSRF guard admits without a DNS lookup. `fetch` is stubbed — nothing
// leaves the process. Only `Date` is faked; the breaker reads time solely
// through `Date.now`, so ticking the clock exercises window decay and the
// cooldown deterministically.

const options: FetchOptions = { timeoutMs: 30_000, userAgent: 'test-agent' };

const netFail = (): Promise<Response> => Promise.reject(new Error('socket hang up'));
const okResponse = () =>
  Promise.resolve(
    new Response('<html><body>ok</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  );

describe('fetchPage circuit-breaker wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('trips the host after 3 failures and fails fast without fetching', async () => {
    const fetchMock = vi.fn(netFail);
    vi.stubGlobal('fetch', fetchMock);
    const url = 'http://203.0.113.1/pricing';

    for (let i = 0; i < 3; i++) {
      await expect(fetchPage(url, options)).rejects.toThrow('socket hang up');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Open: the 4th attempt is rejected by the breaker, not the network.
    await expect(fetchPage(url, options)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('decays failures that age out of the window instead of counting them forever', async () => {
    const fetchMock = vi.fn(netFail);
    vi.stubGlobal('fetch', fetchMock);
    const url = 'http://203.0.113.2/pricing';

    // Two failures now, two more after the 5-minute window has passed:
    // never 3 within one window, so the breaker stays closed — under the
    // old consecutive counter the 3rd failure would have tripped it.
    await expect(fetchPage(url, options)).rejects.toThrow('socket hang up');
    await expect(fetchPage(url, options)).rejects.toThrow('socket hang up');

    vi.advanceTimersByTime(301_000);
    await expect(fetchPage(url, options)).rejects.toThrow('socket hang up');
    await expect(fetchPage(url, options)).rejects.toThrow('socket hang up');
    expect(fetchMock).toHaveBeenCalledTimes(4); // all four reached the network

    // A third failure inside the current window is the density that trips.
    await expect(fetchPage(url, options)).rejects.toThrow('socket hang up');
    await expect(fetchPage(url, options)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('recovers through a half-open probe after the 2-minute cooldown', async () => {
    const fetchMock = vi.fn(netFail);
    vi.stubGlobal('fetch', fetchMock);
    const url = 'http://203.0.113.3/pricing';

    for (let i = 0; i < 3; i++) {
      await expect(fetchPage(url, options)).rejects.toThrow('socket hang up');
    }
    await expect(fetchPage(url, options)).rejects.toBeInstanceOf(CircuitOpenError);

    // Cooldown elapses; the host is healthy again — the probe succeeds and
    // the breaker closes.
    vi.advanceTimersByTime(120_000);
    fetchMock.mockImplementation(okResponse);

    const result = await fetchPage(url, options);
    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('ok');

    // Fully closed: subsequent fetches pass through.
    await expect(fetchPage(url, options)).resolves.toMatchObject({ statusCode: 200 });
  });

  it('isolates breakers per host — one dead host does not block another', async () => {
    const deadUrl = 'http://203.0.113.4/pricing';
    const liveUrl = 'http://203.0.113.5/pricing';
    const fetchMock = vi.fn((input: string | URL) =>
      String(input).includes('203.0.113.4') ? netFail() : okResponse(),
    );
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 3; i++) {
      await expect(fetchPage(deadUrl, options)).rejects.toThrow('socket hang up');
    }
    await expect(fetchPage(deadUrl, options)).rejects.toBeInstanceOf(CircuitOpenError);

    await expect(fetchPage(liveUrl, options)).resolves.toMatchObject({ statusCode: 200 });
  });

  it('rejects SSRF-guarded URLs before any breaker or network activity', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPage('http://127.0.0.1/internal', options)).rejects.toBeInstanceOf(
      UrlGuardError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
