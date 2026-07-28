/**
 * Scheduler tests.
 *
 * The scheduler's contract is entirely about isolation: each job runs on its
 * own interval, and a job that throws is logged rather than propagated. That
 * matters because there is no supervisor above it — an unhandled rejection out
 * of a `setInterval` callback takes the process down, and the process is also
 * the MCP server and the health endpoint. One failing crawl would take the
 * query surface with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduler } from "./index.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createScheduler", () => {
  it("runs a job once per interval and not before the first one elapses", async () => {
    const fn = vi.fn(async () => {});
    const scheduler = createScheduler([{ name: "crawl", intervalMs: 60_000, fn }]);
    scheduler.start();

    // start() schedules; it does not run. The initial crawl is the bootstrap's
    // job, so a scheduler that fired immediately would double it on boot.
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fn).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("keeps a failing job from taking down the others or the process", async () => {
    const failing = vi.fn(async () => {
      throw new Error("embedding backend unreachable");
    });
    const healthy = vi.fn(async () => {});
    const scheduler = createScheduler([
      { name: "crawl", intervalMs: 1_000, fn: failing },
      { name: "sweep", intervalMs: 1_000, fn: healthy },
    ]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(3_000);

    // The failing job keeps being retried on its schedule rather than being
    // dropped after the first error.
    expect(failing).toHaveBeenCalledTimes(3);
    expect(healthy).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("runs jobs on their own intervals", async () => {
    const fast = vi.fn(async () => {});
    const slow = vi.fn(async () => {});
    const scheduler = createScheduler([
      { name: "fast", intervalMs: 1_000, fn: fast },
      { name: "slow", intervalMs: 10_000, fn: slow },
    ]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fast).toHaveBeenCalledTimes(10);
    expect(slow).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  it("stops firing after stop(), and stays stopped", async () => {
    const fn = vi.fn(async () => {});
    const scheduler = createScheduler([{ name: "crawl", intervalMs: 1_000, fn }]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fn).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("is safe to stop twice, which shutdown can do on a doubled signal", async () => {
    const scheduler = createScheduler([{ name: "crawl", intervalMs: 1_000, fn: async () => {} }]);
    scheduler.start();
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("starts with no jobs configured", () => {
    const scheduler = createScheduler([]);
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });
});
