import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from '@slack/bolt';
import { registerHandlers } from './handlers.js';
import type { IntelEngine } from '../intel/index.js';

type Handler = (args: Record<string, unknown>) => Promise<void>;

/** Fake Bolt app that records the registered listeners for direct invocation. */
function fakeApp() {
  const listeners: { event: Record<string, Handler>; message: Handler[] } = {
    event: {},
    message: [],
  };
  const app = {
    event: (name: string, handler: Handler) => {
      listeners.event[name] = handler;
    },
    message: (handler: Handler) => {
      listeners.message.push(handler);
    },
  } as unknown as App;
  return { app, listeners };
}

function makeIntel(answer = 'grounded answer'): IntelEngine {
  return { query: vi.fn(async () => answer) };
}

describe('registerHandlers — app_mention', () => {
  let say: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    say = vi.fn(async () => {});
  });

  const mention = (text: string) => ({
    event: { text, ts: '123.456', user: 'U1' },
    say,
  });

  it('replies with usage guidance when the mention carries no question', async () => {
    const { app, listeners } = fakeApp();
    const intel = makeIntel();
    registerHandlers(app, intel);

    await listeners.event['app_mention']!(mention('<@U0BOT>'));

    expect(intel.query).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Ask me anything') }),
    );
  });

  it('strips the mention, extracts the competitor, and threads the answer', async () => {
    const { app, listeners } = fakeApp();
    const intel = makeIntel('acme shipped SSO');
    registerHandlers(app, intel);

    await listeners.event['app_mention']!(mention('<@U0BOT> what changed about Acme?'));

    expect(intel.query).toHaveBeenCalledWith('what changed about Acme?', { competitor: 'acme' });
    expect(say).toHaveBeenCalledWith({ text: 'acme shipped SSO', thread_ts: '123.456' });
  });

  it('degrades a thrown query to an apologetic threaded reply', async () => {
    const { app, listeners } = fakeApp();
    const intel: IntelEngine = { query: vi.fn(async () => Promise.reject(new Error('bedrock'))) };
    registerHandlers(app, intel);

    await listeners.event['app_mention']!(mention('<@U0BOT> question'));

    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Something went wrong') }),
    );
  });
});

describe('registerHandlers — direct messages', () => {
  const dm = (overrides: Record<string, unknown>) => ({
    message: { channel_type: 'im', text: 'what is new?', user: 'U1', ...overrides },
    say: vi.fn(async () => {}),
  });

  it('answers plain DMs without a competitor filter', async () => {
    const { app, listeners } = fakeApp();
    const intel = makeIntel();
    registerHandlers(app, intel);

    const ctx = dm({});
    await listeners.message[0]!(ctx);

    expect(intel.query).toHaveBeenCalledWith('what is new?');
    expect(ctx.say).toHaveBeenCalledWith({ text: 'grounded answer' });
  });

  it('ignores channel messages, subtypes, and empty text — the Bedrock-spend gate', async () => {
    const { app, listeners } = fakeApp();
    const intel = makeIntel();
    registerHandlers(app, intel);

    const channelMsg = dm({ channel_type: 'channel' });
    const edited = dm({ subtype: 'message_changed' });
    const empty = dm({ text: '' });
    await listeners.message[0]!(channelMsg);
    await listeners.message[0]!(edited);
    await listeners.message[0]!(empty);

    expect(intel.query).not.toHaveBeenCalled();
    expect(channelMsg.say).not.toHaveBeenCalled();
  });
});
