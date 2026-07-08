import { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import type { AlertSink } from './index.js';
import type { SlackBlocks } from './formatter.js';
import { createBreaker } from '../resilience/circuit-breaker.js';

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
export function createSlackSink(botToken: string): AlertSink {
  const client = new WebClient(botToken, { timeout: SLACK_TIMEOUT_MS });
  const breaker = createBreaker('slack-alerts', { failureThreshold: 3 });

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
