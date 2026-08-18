import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anthropicBaseUrl, loadConfig } from "./config.js";

// Every env var loadConfig reads. Cleared before each test so the ambient
// environment (or a local .env) can't leak into the assertions, restored after.
const CONFIG_ENV_KEYS = [
  "MODEL_GATEWAY_ENDPOINT",
  "LLM_ROUTE",
  "EMBEDDING_ROUTE",
  "EMBEDDING_DIMENSIONS",
  "VECTOR_PROVIDER",
  "DATABASE_URL",
  "PG_CA_PATH",
  "CRAWL_INTERVAL_MINUTES",
  "CRAWL_TIMEOUT_MS",
  "USER_AGENT",
  "SLACK_BOT_TOKEN",
  "SLACK_ALERT_CHANNEL",
  "SIGNIFICANCE_THRESHOLD",
  "PORT",
  "MCP_PORT",
  "MCP_AUTH",
  "WORKOS_AUTHKIT_ISSUER",
  "MCP_PUBLIC_URL",
  "MCP_AUTH_SCOPES",
  "NODE_ENV",
  "LOG_LEVEL",
] as const;

describe("loadConfig", () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = process.env;
    process.env = Object.fromEntries(
      Object.entries(saved).filter(
        ([key]) => !(CONFIG_ENV_KEYS as readonly string[]).includes(key),
      ),
    );
    // The gateway endpoint has no default — there is no sensible one, since it
    // is derived from the Platform name. Cases that test its absence clear it
    // again themselves.
    process.env.MODEL_GATEWAY_ENDPOINT = "http://gw.tenants-x.svc.cluster.local:8080";
  });

  afterEach(() => {
    process.env = saved;
  });

  it("applies defaults with an empty environment", () => {
    const c = loadConfig();
    expect(c.llmRoute).toBe("default");
    expect(c.embeddingRoute).toBe("embeddings");
    expect(c.vectorProvider).toBe("memory");
    expect(c.significanceThreshold).toBe(0.3);
    expect(c.slackAlertChannel).toBe("#competitive-intel");
    expect(c.port).toBe(3000);
    expect(c.mcpPort).toBe(3001);
    expect(c.nodeEnv).toBe("development");
  });

  it("coerces numeric env vars", () => {
    process.env.CRAWL_INTERVAL_MINUTES = "15";
    process.env.PORT = "8080";
    process.env.MCP_PORT = "9090";
    process.env.EMBEDDING_DIMENSIONS = "1536";
    const c = loadConfig();
    expect(c.crawlIntervalMinutes).toBe(15);
    expect(c.port).toBe(8080);
    expect(c.mcpPort).toBe(9090);
    expect(c.embeddingDimensions).toBe(1536);
  });

  // ── superRefine: direct-API providers require their key ──────────────────

  it("requires a model gateway endpoint", () => {
    // Every model call goes through the gateway, so an unset endpoint is not a
    // degraded mode — the app has no other way to reach a model and should
    // refuse to start rather than fail on the first crawl.
    process.env.MODEL_GATEWAY_ENDPOINT = "";
    expect(() => loadConfig()).toThrow();
  });

  it("rejects an endpoint that is not a URL", () => {
    // A bare host is the easy mistake, and the SDK would treat it as a relative
    // base and issue requests to nowhere in particular.
    process.env.MODEL_GATEWAY_ENDPOINT = "competitive-intelligence-gateway:8080";
    expect(() => loadConfig()).toThrow();
  });

  // ── outbound alert sink ──────────────────────────────────────────────────

  it("accepts a bot token for the outbound alert sink with no other Slack config", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    expect(loadConfig().slackBotToken).toBe("xoxb-test");
  });
});

describe("anthropicBaseUrl", () => {
  const GATEWAY = "http://gw.tenants-x.svc.cluster.local:8080";

  it("puts the SDK's /v1/messages under the gateway's anthropic prefix", () => {
    // The assertion is on the full path the SDK ultimately requests, not on
    // the base URL alone: the full path is what has to match an endpoint the
    // gateway has registered a processor for.
    expect(`${anthropicBaseUrl(GATEWAY)}/v1/messages`).toBe(`${GATEWAY}/anthropic/v1/messages`);
  });

  it("does not return the bare gateway root", () => {
    // The regression. Handing the root to the SDK produces /v1/messages, which
    // is registered under no endpoint prefix — the OpenAI-shaped set at the
    // root has no `messages` member. The model name is never extracted from
    // the body, no route rule matches, and every analysis call fails while the
    // Gateway reports healthy.
    expect(anthropicBaseUrl(GATEWAY)).not.toBe(GATEWAY);
  });

  it("does not double the separator when the endpoint has a trailing slash", () => {
    expect(anthropicBaseUrl(`${GATEWAY}/`)).toBe(`${GATEWAY}/anthropic`);
  });

  it("leaves the embeddings route reachable from the untouched root", () => {
    // Embeddings speak the OpenAI shape, which the gateway serves at the root.
    // The prefix belongs to the Messages client alone — applying it to the
    // endpoint itself would break embeddings instead.
    expect(anthropicBaseUrl(GATEWAY).startsWith(GATEWAY)).toBe(true);
  });
});
