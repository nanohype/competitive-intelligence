import type { App } from "@slack/bolt";
import type { IntelEngine } from "../intel/index.js";
import { logger } from "../logger.js";

/**
 * Register /sigint slash commands.
 *
 * /sigint query <question>  — Ask a competitive intelligence question
 * /sigint crawl              — Trigger an immediate crawl
 * /sigint status             — Show system status
 */
export function registerCommands(
  app: App,
  intel: IntelEngine,
  runCrawl: () => Promise<void>,
): void {
  app.command("/sigint", async ({ command, ack, respond }) => {
    await ack();

    const args = command.text.trim();
    const [subcommand, ...rest] = args.split(/\s+/);
    const body = rest.join(" ");

    switch (subcommand?.toLowerCase()) {
      case "query":
      case "ask": {
        if (!body) {
          await respond("Usage: `/sigint query <your question>`");
          return;
        }

        logger.info("slash command: query", { user: command.user_id, question: body });

        try {
          const answer = await intel.query(body);
          await respond(answer);
        } catch (err) {
          logger.error("slash query failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          await respond("Query failed. Check the logs.");
        }
        break;
      }

      case "crawl": {
        logger.info("slash command: crawl", { user: command.user_id });
        await respond(":satellite: Starting crawl...");

        try {
          await runCrawl();
          await respond(":white_check_mark: Crawl complete.");
        } catch (err) {
          logger.error("slash crawl failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          await respond(":x: Crawl failed. Check the logs.");
        }
        break;
      }

      case "status": {
        await respond({
          response_type: "ephemeral",
          text: [
            `:satellite_antenna: *sigint status*`,
            `• Uptime: ${formatUptime(process.uptime())}`,
            `• Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
            `• Node: ${process.version}`,
          ].join("\n"),
        });
        break;
      }

      default: {
        await respond({
          response_type: "ephemeral",
          text: [
            "*sigint commands:*",
            "`/sigint query <question>` — Ask about competitors",
            "`/sigint crawl` — Trigger immediate crawl",
            "`/sigint status` — System status",
          ].join("\n"),
        });
      }
    }
  });
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
