import { describe, it, expect, vi } from 'vitest';
import type { App } from '@slack/bolt';
import { registerCommands } from './commands.js';
import type { IntelEngine } from '../intel/index.js';

type CommandHandler = (args: Record<string, unknown>) => Promise<void>;

function setup(opts?: { intel?: IntelEngine; runCrawl?: () => Promise<'ran' | 'skipped'> }) {
  let handler: CommandHandler | undefined;
  const app = {
    command: (_name: string, h: CommandHandler) => {
      handler = h;
    },
  } as unknown as App;
  const intel = opts?.intel ?? { query: vi.fn(async () => 'answer') };
  const runCrawl = opts?.runCrawl ?? vi.fn(async () => 'ran' as const);
  registerCommands(app, intel, runCrawl);

  const invoke = async (text: string) => {
    const ack = vi.fn(async () => {});
    const respond = vi.fn(async () => {});
    await handler!({ command: { text, user_id: 'U1' }, ack, respond });
    return { ack, respond };
  };
  return { invoke, intel, runCrawl };
}

describe('registerCommands — /competitive-intelligence', () => {
  it('acks every invocation before responding', async () => {
    const { ack } = await setup().invoke('status');
    expect(ack).toHaveBeenCalled();
  });

  it('query routes the question through the intel engine', async () => {
    const { invoke, intel } = setup();
    const { respond } = await invoke('query what did acme ship?');

    expect(intel.query).toHaveBeenCalledWith('what did acme ship?');
    expect(respond).toHaveBeenCalledWith('answer');
  });

  it('query without a question replies with usage', async () => {
    const { invoke, intel } = setup();
    const { respond } = await invoke('query');

    expect(intel.query).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('query failures degrade to a check-the-logs reply', async () => {
    const intel: IntelEngine = { query: vi.fn(async () => Promise.reject(new Error('down'))) };
    const { invoke } = setup({ intel });
    const { respond } = await invoke('query anything');

    expect(respond).toHaveBeenCalledWith(expect.stringContaining('Query failed'));
  });

  it('crawl reports completion when the crawl runs', async () => {
    const { invoke, runCrawl } = setup();
    const { respond } = await invoke('crawl');

    expect(runCrawl).toHaveBeenCalled();
    expect(respond).toHaveBeenLastCalledWith(expect.stringContaining('Crawl complete'));
  });

  it('crawl reports the skip when one is already running', async () => {
    const { invoke } = setup({ runCrawl: vi.fn(async () => 'skipped' as const) });
    const { respond } = await invoke('crawl');

    expect(respond).toHaveBeenLastCalledWith(expect.stringContaining('already running'));
  });

  it('crawl failures degrade to a check-the-logs reply', async () => {
    const { invoke } = setup({ runCrawl: vi.fn(async () => Promise.reject(new Error('wedged'))) });
    const { respond } = await invoke('crawl');

    expect(respond).toHaveBeenLastCalledWith(expect.stringContaining('Crawl failed'));
  });

  it('status responds ephemerally with runtime facts', async () => {
    const { invoke } = setup();
    const { respond } = await invoke('status');

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response_type: 'ephemeral',
        text: expect.stringContaining('Uptime'),
      }),
    );
  });

  it('unknown subcommands list the available commands', async () => {
    const { invoke } = setup();
    const { respond } = await invoke('dance');

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('commands:') }),
    );
  });
});
