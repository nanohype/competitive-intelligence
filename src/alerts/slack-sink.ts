import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { createBreaker } from "../resilience/circuit-breaker.js";
import type { SlackBlocks } from "./formatter.js";
import type { AlertSink } from "./index.js";

// Bound the Slack API call so a hung postMessage can't stall the crawl loop
// (the sink is awaited inside the single-writer crawl mutex).
const SLACK_TIMEOUT_MS = 10_000;

/**
 * Outbound alert sink: posts the radar's deterministic Block Kit alerts to
 * Slack via the official `@slack/web-api` client. Outbound-only — no inbound
 * surface, no Slack app. Wrapped in a circuit breaker like every other external
 * call so a degraded Slack endpoint fails fast instead of stalling the crawl
 * loop on every diff.
 */
/**
 * The one call this sink makes. Narrowing to it keeps the injectable seam
 * honest: a test supplies a `chat.postMessage`, not a stand-in for the whole
 * `@slack/web-api` surface.
 */
export interface SlackPoster {
  chat: {
    postMessage(args: { channel: string; text: string; blocks: KnownBlock[] }): Promise<unknown>;
  };
}

export function createSlackSink(botToken: string, poster?: SlackPoster): AlertSink {
  // `poster` is the test seam; production leaves it unset and gets the real
  // client. Injecting the client rather than module-mocking `@slack/web-api`
  // keeps the breaker wiring under test instead of asserting a mock was called.
  const client: SlackPoster = poster ?? new WebClient(botToken, { timeout: SLACK_TIMEOUT_MS });
  const breaker = createBreaker("slack-alerts", { failureThreshold: 3 });

  return {
    async send(channel: string, message: SlackBlocks) {
      await breaker.exec(() =>
        client.chat.postMessage({
          channel,
          text: message.text,
          blocks: message.blocks as KnownBlock[],
        }),
      );
    },
  };
}
