import { describe, it, expect, vi } from 'vitest';
import { callTool, listTools, type McpToolDeps } from './tools.js';
import { createIntelEngine } from '../intel/index.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { VectorStore, SearchResult } from '../providers/vectors.js';
import type { LlmProvider, LlmResponse } from '../providers/llm.js';
import type { Source } from '../crawler/sources.js';

// Fakes implement the provider interfaces directly — no SDK mocking (the MCP
// SDK included). Each tool is exercised through the pure `callTool` dispatcher.

const llmResponse = (text: string): LlmResponse => ({
  text,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const hit = (id: string, content: string, competitor = 'acme'): SearchResult => ({
  id,
  content,
  score: 0.912_34,
  metadata: {
    competitor,
    type: 'pricing',
    url: 'https://acme.example/pricing',
    sourceId: `${competitor}:pricing`,
    title: 'Pricing',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  },
});

function makeDeps(
  overrides: {
    searchResults?: SearchResult[];
    runCrawl?: () => Promise<'ran' | 'skipped'>;
    sources?: Source[];
  } = {},
): { deps: McpToolDeps; store: { search: ReturnType<typeof vi.fn> } } {
  const embedder: EmbeddingProvider = {
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    dimensions: 3,
  };
  const store = {
    search: vi.fn(async () => overrides.searchResults ?? []),
  };
  const llm: LlmProvider = { chat: vi.fn(async () => llmResponse('composed answer')) };
  const intel = createIntelEngine(embedder, store as unknown as VectorStore, llm);
  const deps: McpToolDeps = {
    intel,
    runCrawl: overrides.runCrawl ?? (async () => 'ran'),
    sources: overrides.sources ?? [
      {
        id: 'acme:pricing',
        competitor: 'acme',
        url: 'https://acme.example/pricing',
        type: 'pricing',
      },
    ],
  };
  return { deps, store };
}

function parse(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe('listTools', () => {
  it('advertises exactly the four pull-surface tools', () => {
    const names = listTools().map((t) => t.name);
    expect(names).toEqual(['search_intel', 'trigger_crawl', 'status', 'list_sources']);
  });
});

describe('search_intel', () => {
  it('returns retrieved context (chunks + source metadata), not a composed answer', async () => {
    const { deps, store } = makeDeps({
      searchResults: [hit('1', 'Acme launched an enterprise tier')],
    });

    const result = await callTool(deps, 'search_intel', { question: 'what did acme ship?' });

    expect(result.isError).toBeUndefined();
    const payload = parse(result) as {
      count: number;
      query: { question: string; topK: number };
      results: { content: string; competitor: string; url: string; score: number }[];
    };
    expect(payload.count).toBe(1);
    expect(payload.query.topK).toBe(10);
    expect(payload.results[0].content).toBe('Acme launched an enterprise tier');
    expect(payload.results[0].competitor).toBe('acme');
    expect(payload.results[0].url).toBe('https://acme.example/pricing');
    // Retrieval, not prose: the composed LLM answer text never appears.
    expect(result.content[0].text).not.toContain('composed answer');
    // Default topK threaded through, no competitor filter.
    expect(store.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 10, undefined);
  });

  it('passes the competitor filter and topK through to the store', async () => {
    const { deps, store } = makeDeps({ searchResults: [hit('1', 'c')] });

    await callTool(deps, 'search_intel', { question: 'q', competitor: 'acme', topK: 3 });

    expect(store.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 3, { competitor: 'acme' });
  });

  it('returns an empty result set when the store is empty', async () => {
    const { deps } = makeDeps({ searchResults: [] });

    const result = await callTool(deps, 'search_intel', { question: 'anything' });

    const payload = parse(result) as { count: number; results: unknown[] };
    expect(payload.count).toBe(0);
    expect(payload.results).toEqual([]);
  });

  it('folds an invalid question into an isError result (Zod at the boundary)', async () => {
    const { deps, store } = makeDeps();

    const result = await callTool(deps, 'search_intel', { question: '' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/question/);
    expect(store.search).not.toHaveBeenCalled();
  });

  it('rejects a non-string question without calling the engine', async () => {
    const { deps, store } = makeDeps();

    const result = await callTool(deps, 'search_intel', { question: 42 as unknown as string });

    expect(result.isError).toBe(true);
    expect(store.search).not.toHaveBeenCalled();
  });
});

describe('trigger_crawl', () => {
  it('calls through to runCrawl and returns the outcome', async () => {
    const runCrawl = vi.fn(async () => 'ran' as const);
    const { deps } = makeDeps({ runCrawl });

    const result = await callTool(deps, 'trigger_crawl', {});

    expect(runCrawl).toHaveBeenCalledOnce();
    expect(parse(result)).toEqual({ outcome: 'ran' });
  });

  it('reports a skipped crawl (mutex held / no sources)', async () => {
    const { deps } = makeDeps({ runCrawl: async () => 'skipped' });

    const result = await callTool(deps, 'trigger_crawl', {});

    expect(parse(result)).toEqual({ outcome: 'skipped' });
  });
});

describe('status', () => {
  it('reports uptime, memory, and node version', async () => {
    const { deps } = makeDeps();

    const result = await callTool(deps, 'status', {});

    const payload = parse(result) as { uptimeSeconds: number; memoryMb: number; node: string };
    expect(typeof payload.uptimeSeconds).toBe('number');
    expect(typeof payload.memoryMb).toBe('number');
    expect(payload.node).toBe(process.version);
  });
});

describe('list_sources', () => {
  it('returns the configured sources (id/competitor/url/type)', async () => {
    const { deps } = makeDeps({
      sources: [
        {
          id: 'acme:pricing',
          competitor: 'acme',
          url: 'https://acme.example/pricing',
          type: 'pricing',
        },
        {
          id: 'globex:blog',
          competitor: 'globex',
          url: 'https://globex.example/blog',
          type: 'blog',
        },
      ],
    });

    const result = await callTool(deps, 'list_sources', {});

    expect(parse(result)).toEqual([
      {
        id: 'acme:pricing',
        competitor: 'acme',
        url: 'https://acme.example/pricing',
        type: 'pricing',
      },
      { id: 'globex:blog', competitor: 'globex', url: 'https://globex.example/blog', type: 'blog' },
    ]);
  });
});

describe('unknown tool', () => {
  it('throws (a protocol error, not a tool result)', async () => {
    const { deps } = makeDeps();
    await expect(callTool(deps, 'nope', {})).rejects.toThrow(/Unknown tool/);
  });
});
