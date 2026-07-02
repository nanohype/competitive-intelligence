import type { App } from '@slack/bolt';
import type { IntelEngine } from '../intel/index.js';
import { logger, toMessage } from '../logger.js';

/**
 * Register /competitive-intelligence slash commands.
 *
 * /competitive-intelligence query <question>  — Ask a competitive intelligence question
 * /competitive-intelligence crawl              — Trigger an immediate crawl
 * /competitive-intelligence status             — Show system status
 */
export function registerCommands(
  app: App,
  intel: IntelEngine,
  runCrawl: () => Promise<'ran' | 'skipped'>,
): void {
  app.command('/competitive-intelligence', async ({ command, ack, respond }) => {
    await ack();

    const args = command.text.trim();
    const [subcommand, ...rest] = args.split(/\s+/);
    const body = rest.join(' ');

    switch (subcommand?.toLowerCase()) {
      case 'query':
      case 'ask': {
        if (!body) {
          await respond('Usage: `/competitive-intelligence query <your question>`');
          return;
        }

        logger.info('slash command: query', { user: command.user_id, question: body });

        try {
          const answer = await intel.query(body);
          await respond(answer);
        } catch (err) {
          logger.error('slash query failed', { error: toMessage(err) });
          await respond('Query failed. Check the logs.');
        }
        break;
      }

      case 'crawl': {
        logger.info('slash command: crawl', { user: command.user_id });
        await respond(':satellite: Starting crawl...');

        try {
          const outcome = await runCrawl();
          await respond(
            outcome === 'skipped'
              ? ':hourglass_flowing_sand: A crawl is already running (or no sources are configured) — skipped.'
              : ':white_check_mark: Crawl complete.',
          );
        } catch (err) {
          logger.error('slash crawl failed', { error: toMessage(err) });
          await respond(':x: Crawl failed. Check the logs.');
        }
        break;
      }

      case 'status': {
        await respond({
          response_type: 'ephemeral',
          text: [
            `:satellite_antenna: *competitive-intelligence status*`,
            `• Uptime: ${formatUptime(process.uptime())}`,
            `• Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
            `• Node: ${process.version}`,
          ].join('\n'),
        });
        break;
      }

      default: {
        await respond({
          response_type: 'ephemeral',
          text: [
            '*competitive-intelligence commands:*',
            '`/competitive-intelligence query <question>` — Ask about competitors',
            '`/competitive-intelligence crawl` — Trigger immediate crawl',
            '`/competitive-intelligence status` — System status',
          ].join('\n'),
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
