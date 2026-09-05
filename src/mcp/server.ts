import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger, toMessage } from "../logger.js";
import type { OAuthProtection } from "./oauth.js";
import { type McpToolDeps, registerTools } from "./tools.js";

/** The path the streamable-HTTP transport is served on. */
export const MCP_PATH = "/mcp";

/**
 * Construct the MCP server for one connection. Tools are stateless functions
 * over the injected deps, so a fresh server per request is correct and avoids
 * session bookkeeping — the tunnel routes each request to this in-cluster
 * surface by hostname.
 */
export function createMcpServer(deps: McpToolDeps): Server {
  const server = new Server(
    { name: "competitive-intelligence", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, deps);
  return server;
}

export interface McpHttpServer {
  /**
   * Bind and resolve with the port actually bound. Pass 0 to let the kernel
   * choose one: it is held from the moment it is assigned, so there is no
   * instant at which the port is decided and not yet listening. Choosing a free
   * port by some other means and binding it afterwards cannot offer that — the
   * answer is true when it is read and something else may take the port before
   * the bind, and no retry closes that window because the window is what a
   * retry re-enters.
   */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Streamable-HTTP MCP server. Bound on its own port (`MCP_PORT`), separate from
 * the `/health`+`/readyz` liveness server on `PORT`. Stateless mode: each
 * request gets a fresh `Server` + transport, so there is no session state to
 * carry across the tunnel.
 *
 * `oauth` is optional. Unset → the port stays open, protected by the mcp-tunnel
 * + NetworkPolicy alone (the default deployment mode). Set → the port becomes an
 * OAuth 2.1 resource server: it advertises Protected Resource Metadata and
 * requires a valid WorkOS-issued bearer token on `/mcp`, so the surface can be
 * added directly as a Claude custom connector over a public tunnel.
 */
export function createMcpHttpServer(deps: McpToolDeps, oauth?: OAuthProtection): McpHttpServer {
  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res, deps, oauth);
  });

  return {
    listen: (port) =>
      new Promise<number>((resolve, reject) => {
        // A bind that fails emits `error` and never calls the listening
        // callback. The caller is waiting for a port, so that has to settle the
        // promise rather than leave it pending and the error unhandled; the
        // listener comes off on success so a later runtime error is not
        // rerouted into a promise nobody is holding.
        httpServer.once("error", reject);
        httpServer.listen(port, () => {
          httpServer.removeListener("error", reject);
          // `listen` was given a number, so this is a TCP socket and the
          // listening callback fires only after the bind — where `address()`
          // is an AddressInfo rather than a pipe's path or null.
          resolve((httpServer.address() as AddressInfo).port);
        });
      }),
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
  oauth?: OAuthProtection,
): Promise<void> {
  const url = req.url ?? "";
  const pathname = url.split("?", 1)[0];

  // Protected Resource Metadata (RFC 9728) — always unauthenticated, so a client
  // can discover the authorization server before it holds a token. Only mounted
  // when OAuth is enabled.
  if (oauth?.isMetadataRequest(pathname)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(oauth.metadata));
    return;
  }

  if (!url.startsWith(MCP_PATH)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
    return;
  }

  // Bearer enforcement on /mcp. Open mode (oauth unset) skips straight through.
  if (oauth) {
    const decision = await oauth.authorize(req.headers.authorization);
    if (!decision.ok) {
      res.writeHead(decision.status, {
        "content-type": "application/json",
        "www-authenticate": decision.wwwAuthenticate,
      });
      res.end(JSON.stringify(decision.body));
      return;
    }
  }

  const server = createMcpServer(deps);
  // Stateless: no session id, respond with a single JSON body rather than an
  // SSE stream — the tunnel proxies plain request/response.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    logger.error("mcp request failed", { error: toMessage(err) });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
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
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}
