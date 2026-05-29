import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { Config } from "../config.js";
import type { IntelEngine } from "../intel/index.js";
import type { AlertSink } from "../alerts/index.js";
import type { SlackBlocks } from "../alerts/formatter.js";
import { registerHandlers } from "./handlers.js";
import { registerCommands } from "./commands.js";
import { logger } from "../logger.js";

export interface SlackBot {
  app: App;
  sink: AlertSink;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSlackBot(
  config: Config,
  intel: IntelEngine,
  runCrawl: () => Promise<void>,
): SlackBot {
  const app = new App({
    token: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
    appToken: config.slackAppToken,
    socketMode: !!config.slackAppToken,
  });

  // Wire up event handlers and slash commands
  registerHandlers(app, intel);
  registerCommands(app, intel, runCrawl);

  // Alert sink that posts to Slack channels
  const sink: AlertSink = {
    async send(channel: string, message: SlackBlocks) {
      await app.client.chat.postMessage({
        token: config.slackBotToken,
        channel,
        text: message.text,
        blocks: message.blocks as KnownBlock[],
      });
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
        logger.info("slack bot started (http mode)", { port: config.port });
      }
    },
    async stop() {
      await app.stop();
      logger.info("slack bot stopped");
    },
  };
}
