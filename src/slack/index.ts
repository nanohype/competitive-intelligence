import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { Config } from "../config.js";
import type { IntelEngine } from "../intel/index.js";
import type { AlertSink } from "../alerts/index.js";
import type { SlackBlocks } from "../alerts/formatter.js";
import { registerHandlers } from "./handlers.js";
import { registerCommands } from "./commands.js";
import { logger } from "../logger.js";
import { CircuitBreaker } from "../resilience/circuit-breaker.js";

// Bound the Slack API call so a hung postMessage can't stall the crawl loop
// (the sink is awaited inside the single-writer crawl mutex).
const SLACK_TIMEOUT_MS = 10_000;

export interface SlackBot {
  app: App;
  sink: AlertSink;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSlackBot(
  config: Config,
  intel: IntelEngine,
  runCrawl: () => Promise<"ran" | "skipped">,
): SlackBot {
  const app = new App({
    token: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
    appToken: config.slackAppToken,
    socketMode: !!config.slackAppToken,
    clientOptions: { timeout: SLACK_TIMEOUT_MS },
  });

  // Wire up event handlers and slash commands
  registerHandlers(app, intel);
  registerCommands(app, intel, runCrawl);

  // Alert sink that posts to Slack channels — wrapped in a circuit breaker like
  // every other external call, so a degraded Slack endpoint fails fast instead
  // of stalling the crawl loop on every diff.
  const breaker = new CircuitBreaker("slack-alerts", { failureThreshold: 3 });
  const sink: AlertSink = {
    async send(channel: string, message: SlackBlocks) {
      await breaker.execute(() =>
        app.client.chat.postMessage({
          token: config.slackBotToken,
          channel,
          text: message.text,
          blocks: message.blocks as KnownBlock[],
        }),
      );
    },
  };

  return {
    app,
    sink,
    async start() {
      if (config.slackAppToken) {
        await app.start();
        logger.info("slack bot started (socket mode)");
      } else {
        // HTTP mode: the Bolt receiver must actually listen, or no Slack events
        // arrive. Bind it one port above the health server (which owns
        // config.port) so the two HTTP servers don't collide.
        const eventsPort = config.port + 1;
        await app.start(eventsPort);
        logger.info("slack bot started (http mode)", {
          eventsPort,
          healthPort: config.port,
        });
      }
    },
    async stop() {
      await app.stop();
      logger.info("slack bot stopped");
    },
  };
}
