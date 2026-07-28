import http from "node:http";
import { toMessage } from "./logger.js";
import type { VectorStore } from "./providers/vectors.js";

/**
 * Tiny liveness/readiness server.
 *
 * Bound on `config.port`, separate from the MCP server (`config.mcpPort`).
 * `/health` is pure liveness (process is up). `/readyz` is readiness — it
 * resolves `store.count()`; a reachable vector store → 200, anything else →
 * 503 so the pod is pulled out of rotation (and rollouts wait) until the
 * backend recovers.
 *
 * The distinction is the point. If `/readyz` also answered on liveness alone,
 * a rollout would march on with an unreachable pgvector behind it and every
 * new pod would report healthy while serving nothing.
 */
export function createHealthServer(store: VectorStore): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && url === "/readyz") {
      store
        .count()
        .then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ready" }));
        })
        .catch((err: unknown) => {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              status: "unready",
              error: toMessage(err),
            }),
          );
        });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });
}
