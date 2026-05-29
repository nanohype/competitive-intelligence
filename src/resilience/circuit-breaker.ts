/**
 * Threshold-based circuit breaker. Trips open after `failureThreshold`
 * consecutive failures, waits `resetTimeoutMs` before allowing a half-open
 * probe, and resets fully on a successful call.
 *
 * This is a simple counter-based implementation, not a sliding window —
 * all failures since the last reset count equally regardless of age.
 */

type State = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxAttempts?: number;
}

export class CircuitBreaker {
  private state: State = "closed";
  private failures = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;

  constructor(
    private readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 60_000;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? 1;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = "half-open";
        this.halfOpenAttempts = 0;
      } else {
        throw new Error(`Circuit breaker "${this.name}" is open`);
      }
    }

    if (this.state === "half-open" && this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
      this.trip();
      throw new Error(`Circuit breaker "${this.name}" tripped during half-open probe`);
    }

    try {
      if (this.state === "half-open") this.halfOpenAttempts++;
      const result = await fn();
      this.reset();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = "open";
  }

  private reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.halfOpenAttempts = 0;
  }
}
