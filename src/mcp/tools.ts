import { z } from 'zod';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { IntelEngine } from '../intel/index.js';
import type { Source } from '../crawler/sources.js';
import type { SearchResult } from '../providers/vectors.js';

/**
 * The pull surface: the four tools the MCP server advertises. The consuming
 * model (a Claude surface reaching in over the tunnel) does the reasoning —
 * `search_intel` hands back the retrieved context, not a composed answer, so
 * retrieval is the contract and the caller grounds on it.
 */
export interface McpToolDeps {
  intel: IntelEngine;
  /** The single-writer crawl trigger — the in-process mutex'd `runCrawl`. */
  runCrawl: () => Promise<'ran' | 'skipped'>;
  /** The Zod-validated source set loaded from `sources.json`. */
  sources: Source[];
}

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The exact tool list the server advertises on `tools/list`. Stable across the
 * server's lifetime. Exposed as a pure helper for tests.
 */
export function listTools(): ToolDescriptor[] {
  return [
    {
      name: 'search_intel',
      description:
        'Search accumulated competitive intelligence and return the ranked context (matching chunks + their source metadata) for a natural-language question. Returns retrieved evidence to reason over, not a composed answer. Optionally scope to one competitor and cap the number of chunks.',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The natural-language question about competitors.',
          },
          competitor: {
            type: 'string',
            description:
              'Optional competitor name to scope the search to (matches the source `competitor` field).',
          },
          topK: {
            type: 'number',
            description: 'Optional maximum number of chunks to return (1–50, default 10).',
          },
        },
        required: ['question'],
      },
    },
    {
      name: 'trigger_crawl',
      description:
        'Trigger an immediate crawl of all configured sources through the single-writer crawl mutex. Returns whether the crawl ran or was skipped (another crawl already in progress, or no sources configured).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'status',
      description: 'Report process health: uptime, resident heap usage, and the Node.js version.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_sources',
      description:
        'List the configured crawl sources (id, competitor, url, type) from the Zod-validated source set.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

// ── Input validation ─────────────────────────────────────────────────────────
// Tool arguments arrive from an LLM client and the declared inputSchema is
// advisory — nothing in the protocol enforces it. Every argument is re-parsed
// with Zod at this boundary (the app validates every boundary with Zod).
// Failures throw a ZodError; `callTool` folds it into an `isError` result with
// the message intact so the calling model can self-correct.

const searchIntelArgs = z.object({
  question: z.string().min(1, 'question must be a non-empty string'),
  competitor: z.string().min(1).optional(),
  topK: z.number().int().min(1).max(50).optional(),
});

const noArgs = z.object({}).strip();

/**
 * The MCP tool-result shape. `isError: true` marks a tool-level failure. A type
 * alias (not an interface) so it carries an implicit index signature and stays
 * assignable to the SDK's `ServerResult` union.
 */
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: true;
};

/**
 * Marker for a tool name the server never advertised. Per the MCP spec an
 * unknown tool is a protocol error, not a tool result — so this is the one
 * failure `callTool` re-throws instead of folding into `isError: true`.
 */
class UnknownToolError extends Error {}

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Shape one search hit into the context payload returned to the caller. */
function toContext(hit: SearchResult): Record<string, unknown> {
  return {
    id: hit.id,
    score: Number(hit.score.toFixed(4)),
    content: hit.content,
    competitor: hit.metadata.competitor,
    type: hit.metadata.type,
    url: hit.metadata.url,
    sourceId: hit.metadata.sourceId,
    title: hit.metadata.title,
    fetchedAt: hit.metadata.fetchedAt,
  };
}

/**
 * Dispatch a tool call to the right handler. Unknown tools throw (a protocol
 * error — the client called something the server never advertised). Everything
 * a known tool does wrong — bad arguments, an upstream failure — comes back as
 * an `isError: true` result so MCP clients handle it as a tool failure instead
 * of a broken connection. Exposed as a pure helper for tests.
 */
export async function callTool(
  deps: McpToolDeps,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  try {
    return await dispatchTool(deps, name, args);
  } catch (err) {
    if (err instanceof UnknownToolError) throw err;
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join('; ')
        : err instanceof Error
          ? err.message
          : String(err);
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

async function dispatchTool(
  deps: McpToolDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'search_intel': {
      const { question, competitor, topK } = searchIntelArgs.parse(args);
      const results = await deps.intel.retrieve(question, { competitor, topK });
      return json({
        query: { question, competitor: competitor ?? null, topK: topK ?? 10 },
        count: results.length,
        results: results.map(toContext),
      });
    }
    case 'trigger_crawl': {
      noArgs.parse(args);
      const outcome = await deps.runCrawl();
      return json({ outcome });
    }
    case 'status': {
      noArgs.parse(args);
      return json({
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        node: process.version,
      });
    }
    case 'list_sources': {
      noArgs.parse(args);
      return json(
        deps.sources.map((s) => ({
          id: s.id,
          competitor: s.competitor,
          url: s.url,
          type: s.type,
        })),
      );
    }
    default:
      throw new UnknownToolError(`Unknown tool: ${name}`);
  }
}

/** Wire the tool handlers onto an MCP server. */
export function registerTools(server: Server, deps: McpToolDeps): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return callTool(deps, name, args ?? {});
  });
}
