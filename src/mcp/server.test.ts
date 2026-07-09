import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import http from 'node:http';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer, type McpHttpServer } from './server.js';
import { createOAuthProtection, createWorkosVerifier } from './oauth.js';
import type { McpToolDeps } from './tools.js';
import { createIntelEngine } from '../intel/index.js';
import type { EmbeddingProvider } from '../providers/embeddings.js';
import type { VectorStore, SearchResult } from '../providers/vectors.js';
import type { LlmProvider } from '../providers/llm.js';

// End-to-end wiring: a real MCP client speaks the streamable-HTTP transport to
// a real in-process server. Nothing in the MCP SDK is mocked — only the app's
// own provider interfaces are faked. This exercises server.ts (transport +
// per-request server construction) the way a Claude surface would over the
// tunnel.

const hit = (content: string): SearchResult => ({
  id: '1',
  content,
  score: 0.9,
  metadata: {
    competitor: 'acme',
    type: 'pricing',
    url: 'https://acme.example/pricing',
    sourceId: 'acme:pricing',
    title: 'Pricing',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  },
});

function makeDeps(): McpToolDeps {
  const embedder: EmbeddingProvider = {
    embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
    dimensions: 3,
  };
  const store = { search: async () => [hit('Acme launched an enterprise tier')] };
  const llm: LlmProvider = {
    chat: async () => ({
      text: 'x',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
  };
  return {
    intel: createIntelEngine(embedder, store as unknown as VectorStore, llm),
    runCrawl: vi.fn(async () => 'ran' as const),
    sources: [
      {
        id: 'acme:pricing',
        competitor: 'acme',
        url: 'https://acme.example/pricing',
        type: 'pricing',
      },
    ],
  };
}

async function port(server: McpHttpServer): Promise<number> {
  // Listen on an ephemeral port by asking the underlying server; createMcpHttpServer
  // wraps node http, so bind :0 and read it back through a throwaway probe server
  // is not exposed — instead pick a free port via a scratch server.
  const scratch = http.createServer();
  await new Promise<void>((resolve) => scratch.listen(0, resolve));
  const p = (scratch.address() as AddressInfo).port;
  await new Promise<void>((resolve) => scratch.close(() => resolve()));
  await server.listen(p);
  return p;
}

describe('MCP streamable-HTTP server (end-to-end)', () => {
  let server: McpHttpServer;
  let client: Client;
  let url: URL;

  beforeEach(async () => {
    server = createMcpHttpServer(makeDeps());
    const p = await port(server);
    url = new URL(`http://127.0.0.1:${p}/mcp`);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('advertises the four tools over the transport', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_sources',
      'search_intel',
      'status',
      'trigger_crawl',
    ]);
  });

  it('returns retrieved context from search_intel', async () => {
    const result = await client.callTool({
      name: 'search_intel',
      arguments: { question: 'what did acme ship?' },
    });
    const content = result.content as { type: string; text: string }[];
    const payload = JSON.parse(content[0].text) as { count: number };
    expect(payload.count).toBe(1);
    expect(content[0].text).toContain('enterprise tier');
  });

  it('runs trigger_crawl through the injected runCrawl', async () => {
    const result = await client.callTool({ name: 'trigger_crawl', arguments: {} });
    const content = result.content as { text: string }[];
    expect(JSON.parse(content[0].text)).toEqual({ outcome: 'ran' });
  });

  it('surfaces a bad argument as a tool error, not a broken connection', async () => {
    const result = await client.callTool({
      name: 'search_intel',
      arguments: { question: '' },
    });
    expect(result.isError).toBe(true);
  });
});

// OAuth resource-server mode, end-to-end over real HTTP. A local RSA key set
// signs the tokens and backs the verifier (no live WorkOS, no SDK mocking), so
// the whole path — metadata discovery, the 401 challenge, and audience binding
// on a real request — is exercised as a Claude connector would drive it.
describe('MCP streamable-HTTP server (OAuth enabled)', () => {
  const ISSUER = 'https://ci-tenant.authkit.app';
  const RESOURCE = 'https://ci.example.com/mcp';

  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let server: McpHttpServer;
  let base: string;

  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair('RS256'));
  });

  async function mint(aud = RESOURCE): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('user_123')
      .setIssuer(ISSUER)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  beforeEach(async () => {
    const verify = createWorkosVerifier({ issuer: ISSUER, audience: RESOURCE, jwks: publicKey });
    const oauth = createOAuthProtection({ issuer: ISSUER, resource: RESOURCE }, verify);
    server = createMcpHttpServer(makeDeps(), oauth);
    const p = await port(server);
    base = `http://127.0.0.1:${p}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves Protected Resource Metadata unauthenticated', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
    };
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.bearer_methods_supported).toEqual(['header']);
  });

  it('401s /mcp without a token, pointing at the resource metadata', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://ci.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('401s a token bound to a different resource (RFC 8707 audience)', async () => {
    const token = await mint('https://someone-else.example.com/mcp');
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('admits a correctly-audienced token through the full MCP handshake', async () => {
    const token = await mint();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_sources',
      'search_intel',
      'status',
      'trigger_crawl',
    ]);
    await client.close();
  });
});
