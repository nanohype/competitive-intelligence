/**
 * App wiring over the vendored @nanohype/runtime circuit breaker
 * (`src/vendor/runtime/circuit-breaker.ts` — sliding-window failure
 * accounting, injectable clock, single half-open probe).
 *
 * Semantics: the breaker trips when `failureThreshold` failures land
 * within a rolling `windowMs` — failure density, not a consecutive
 * count. Old failures decay out of the window instead of accumulating
 * across crawl cycles. Config mapping from the pre-unification counter
 * breaker: `failureThreshold` carries over unchanged, the old
 * `resetTimeoutMs` cooldown is `halfOpenAfterMs`, and the window
 * defaults to 5 minutes — wide enough that `failureThreshold`
 * back-to-back worst-case calls (fetch 30s, LLM 60s, embed 30s,
 * Slack 10s deadlines) always land inside one window, so a hard-down
 * target trips exactly as fast as the counter did.
 *
 * This module owns the metrics wiring: `onOpen` raises the
 * `circuit_breaker.open` gauge (backs the CircuitBreakerOpen alert +
 * dashboard panel) and `onClose` lowers it — the breaker reports its own
 * state transitions, so nothing here wraps exec/reset.
 */

import { createCircuitBreaker, type CircuitBreaker } from '../vendor/runtime/circuit-breaker.js';
import { setCircuitBreakerOpen } from '../metrics.js';

export {
  CircuitOpenError,
  type CircuitBreaker,
  type CircuitState,
} from '../vendor/runtime/circuit-breaker.js';

export interface BreakerOptions {
  /** Failures within the window that trip the breaker. @default 5 */
  failureThreshold?: number;
  /** Rolling window for failure accounting, in ms. @default 300_000 */
  windowMs?: number;
  /** Cooldown before a single half-open probe, in ms. @default 60_000 */
  halfOpenAfterMs?: number;
}

export function createBreaker(name: string, options: BreakerOptions = {}): CircuitBreaker {
  return createCircuitBreaker({
    name,
    failureThreshold: options.failureThreshold ?? 5,
    windowMs: options.windowMs ?? 300_000,
    halfOpenAfterMs: options.halfOpenAfterMs ?? 60_000,
    onOpen: (n) => setCircuitBreakerOpen(n, true),
    onClose: (n) => setCircuitBreakerOpen(n, false),
  });
}
