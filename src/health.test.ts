/**
 * Health/readiness server tests.
 *
 * These two endpoints decide whether Kubernetes keeps the pod in rotation and
 * whether a rollout proceeds. The distinction between them is the whole point:
 * `/health` answers "the process is up", `/readyz` answers "the vector store is
 * reachable". If readiness collapsed into liveness, a rollout would march on
 * with an unreachable pgvector behind it and every new pod would report healthy
 * while serving nothing.
 *
 * A real `node:http` server on an ephemeral port, driven with real requests.
 */

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthServer } from "./health.js";
import type { VectorStore } from "./providers/vectors.js";

function storeWhoseCount(behavior: "resolves" | "rejects"): VectorStore {
  return {
    async upsert() {},
    async search() {
      return [];
    },
    async delete() {},
    async deleteByMetadata() {
      return 0;
    },
    async count() {
      if (behavior === "rejects") throw new Error("ECONNREFUSED 10.0.0.5:5432");
      return 7;
    },
  };
}

const servers: Array<ReturnType<typeof createHealthServer>> = [];

async function serve(store: VectorStore): Promise<string> {
  const server = createHealthServer(store);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("GET /health", () => {
  it("reports liveness without consulting the vector store", async () => {
    // Liveness must not depend on a backend: if it did, an unreachable database
    // would make the kubelet restart a process that is working fine, in a loop.
    const base = await serve(storeWhoseCount("rejects"));
    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /readyz", () => {
  it("returns 200 when the vector store answers", async () => {
    const base = await serve(storeWhoseCount("resolves"));
    const res = await fetch(`${base}/readyz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });

  it("returns 503 with the reason when the vector store is unreachable", async () => {
    const base = await serve(storeWhoseCount("rejects"));
    const res = await fetch(`${base}/readyz`);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "unready",
      error: expect.stringContaining("ECONNREFUSED"),
    });
  });
});

describe("everything else", () => {
  it("404s an unknown path", async () => {
    const base = await serve(storeWhoseCount("resolves"));
    const res = await fetch(`${base}/metrics`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: "not_found" });
  });

  it("404s a non-GET request to a known path", async () => {
    const base = await serve(storeWhoseCount("resolves"));
    const res = await fetch(`${base}/readyz`, { method: "POST" });

    expect(res.status).toBe(404);
  });
});
