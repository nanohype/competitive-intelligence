import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, type McpToolDeps } from './tools.js';
import { logger, toMessage } from '../logger.js';

/** The path the streamable-HTTP transport is served on. */
export const MCP_PATH = '/mcp';

/**
 * Construct the MCP server for one connection. Tools are stateless functions
 * over the injected deps, so a fresh server per request is correct and avoids
 * session bookkeeping — the tunnel routes each request to this in-cluster
 * surface by hostname.
 */
export function createMcpServer(deps: McpToolDeps): Server {
  const server = new Server(
    { name: 'competitive-intelligence', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerTools(server, deps);
  return server;
}

export interface McpHttpServer {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Streamable-HTTP MCP server. Bound on its own port (`MCP_PORT`), separate from
 * the `/health`+`/readyz` liveness server on `PORT`. Stateless mode: each
 * request gets a fresh `Server` + transport, so there is no session state to
 * carry across the tunnel. The mcp-tunnel (outbound-only `cloudflared`) is the
 * only ingress to this port — enforced by the chart NetworkPolicy.
 */
export function createMcpHttpServer(deps: McpToolDeps): McpHttpServer {
  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res, deps);
  });

  return {
    listen: (port) => new Promise<void>((resolve) => httpServer.listen(port, resolve)),
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: McpToolDeps,
): Promise<void> {
  const url = req.url ?? '';
  if (!url.startsWith(MCP_PATH)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_found' }));
    return;
  }

  const server = createMcpServer(deps);
  // Stateless: no session id, respond with a single JSON body rather than an
  // SSE stream — the tunnel proxies plain request/response.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    logger.error('mcp request failed', { error: toMessage(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }),
      );
    }
  }
}

/** Collect and parse a JSON request body; `undefined` for an empty body. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return undefined;
  return JSON.parse(raw);
}
