import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("passes through successful calls", async () => {
    const cb = new CircuitBreaker("test");
    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
  });

  it("propagates errors from the wrapped function", async () => {
    const cb = new CircuitBreaker("test");
    await expect(
      cb.execute(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("trips open after reaching failure threshold", async () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 2 });
    const fail = () =>
      cb.execute(async () => {
        throw new Error("fail");
      });

    await expect(fail()).rejects.toThrow("fail");
    await expect(fail()).rejects.toThrow("fail");
    // Now open — should throw circuit breaker error, not "fail"
    await expect(fail()).rejects.toThrow('Circuit breaker "test" is open');
  });

  it("transitions to half-open after reset timeout", async () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      resetTimeoutMs: 10,
    });

    // Trip it
    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 20));

    // Should allow one probe call through (half-open)
    const result = await cb.execute(async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("resets fully after successful half-open probe", async () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      resetTimeoutMs: 10,
    });

    await expect(
      cb.execute(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    await new Promise((r) => setTimeout(r, 20));

    // Successful probe resets the breaker
    await cb.execute(async () => "ok");

    // Now should work normally
    const result = await cb.execute(async () => "still ok");
    expect(result).toBe("still ok");
  });
});
