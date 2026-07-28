/**
 * Outbound Slack sink tests.
 *
 * The sink is awaited inside the single-writer crawl mutex, so its failure
 * behavior is a property of the crawl loop rather than of Slack: an unbounded
 * or un-breakered call here stalls the radar for every source behind it. These
 * exercise the real breaker wiring with the Slack client injected, rather than
 * module-mocking `@slack/web-api` — which would have left the wiring untested
 * and asserted only that a fake was called.
 */

import { describe, expect, it, vi } from "vitest";
import { createSlackSink, type SlackPoster } from "./slack-sink.js";

const MESSAGE = {
  text: "Acme changed its pricing",
  blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Acme*" } }],
} as Parameters<ReturnType<typeof createSlackSink>["send"]>[1];

function poster(behavior: "ok" | "fail" = "ok") {
  const postMessage = vi.fn(async () => {
    if (behavior === "fail") throw new Error("slack 503");
    return { ok: true };
  });
  return { poster: { chat: { postMessage } } as SlackPoster, postMessage };
}

describe("createSlackSink", () => {
  it("posts the alert's text and blocks to the requested channel", async () => {
    const { poster: p, postMessage } = poster();
    await createSlackSink("xoxb-test", p).send("#competitive-intel", MESSAGE);

    expect(postMessage).toHaveBeenCalledWith({
      channel: "#competitive-intel",
      text: "Acme changed its pricing",
      blocks: MESSAGE.blocks,
    });
  });

  it("propagates a failure so the alert engine can record it", async () => {
    // The engine catches this and increments alert_send_failure. Swallowing it
    // here would make a Slack outage look like a week with no competitor news.
    const { poster: p } = poster("fail");
    await expect(
      createSlackSink("xoxb-test", p).send("#competitive-intel", MESSAGE),
    ).rejects.toThrow(/slack 503/);
  });

  it("opens the breaker after repeated failures instead of retrying forever", async () => {
    const { poster: p, postMessage } = poster("fail");
    const sink = createSlackSink("xoxb-test", p);

    // failureThreshold: 3 — the fourth send is rejected by the open breaker
    // without a call, which is what keeps a degraded Slack from adding its
    // latency to every diff in the crawl.
    for (let i = 0; i < 3; i++) {
      await expect(sink.send("#competitive-intel", MESSAGE)).rejects.toThrow();
    }
    expect(postMessage).toHaveBeenCalledTimes(3);

    await expect(sink.send("#competitive-intel", MESSAGE)).rejects.toThrow(/circuit/i);
    expect(postMessage).toHaveBeenCalledTimes(3);
  });
});
