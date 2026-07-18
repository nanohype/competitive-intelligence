import { beforeEach, describe, expect, it, vi } from "vitest";

// The vendored breaker's state machine (trip, window decay, half-open probe,
// recovery) is tested at its source of truth — nanohype/library/runtime.
// These tests cover this app's wiring only: the config mapping in
// `createBreaker` and the `circuit_breaker.open` gauge lifecycle.
vi.mock("../metrics.js", () => ({ setCircuitBreakerOpen: vi.fn() }));

import { setCircuitBreakerOpen } from "../metrics.js";
import { CircuitOpenError, createBreaker } from "./circuit-breaker.js";

const fail = () => Promise.reject(new Error("boom"));
const ok = () => Promise.resolve("ok");

describe("createBreaker (app wiring)", () => {
  beforeEach(() => {
    vi.mocked(setCircuitBreakerOpen).mockClear();
  });

  it("trips at failureThreshold, raises the gauge once, and fails fast", async () => {
    const breaker = createBreaker("wiring-trip", { failureThreshold: 2 });

    await expect(breaker.exec(fail)).rejects.toThrow("boom");
    expect(setCircuitBreakerOpen).not.toHaveBeenCalled();

    await expect(breaker.exec(fail)).rejects.toThrow("boom");
    expect(setCircuitBreakerOpen).toHaveBeenCalledExactlyOnceWith("wiring-trip", true);
    expect(breaker.state()).toBe("open");

    // Fast-fail while open — the wrapped function is not invoked and the
    // gauge is not re-raised.
    const probe = vi.fn(ok);
    await expect(breaker.exec(probe)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(probe).not.toHaveBeenCalled();
    expect(setCircuitBreakerOpen).toHaveBeenCalledTimes(1);
  });

  it("lowers the gauge when a half-open probe recovers, and only on transitions", async () => {
    let t = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    const breaker = createBreaker("wiring-success", {
      failureThreshold: 1,
      halfOpenAfterMs: 30_000,
    });

    // A plain success while closed is not a transition — the gauge is untouched.
    await expect(breaker.exec(ok)).resolves.toBe("ok");
    expect(setCircuitBreakerOpen).not.toHaveBeenCalled();

    await expect(breaker.exec(fail)).rejects.toThrow("boom");
    expect(setCircuitBreakerOpen).toHaveBeenLastCalledWith("wiring-success", true);

    t += 30_000;
    await expect(breaker.exec(ok)).resolves.toBe("ok");
    expect(setCircuitBreakerOpen).toHaveBeenLastCalledWith("wiring-success", false);
    expect(setCircuitBreakerOpen).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("reset() force-closes and lowers the gauge", async () => {
    const breaker = createBreaker("wiring-reset", { failureThreshold: 1 });

    await expect(breaker.exec(fail)).rejects.toThrow("boom");
    expect(breaker.state()).toBe("open");

    breaker.reset();
    expect(breaker.state()).toBe("closed");
    expect(setCircuitBreakerOpen).toHaveBeenLastCalledWith("wiring-reset", false);
  });

  it("propagates results and errors transparently", async () => {
    const breaker = createBreaker("wiring-passthrough");

    await expect(breaker.exec(async () => 42)).resolves.toBe(42);
    await expect(breaker.exec(fail)).rejects.toThrow("boom");
  });
});
