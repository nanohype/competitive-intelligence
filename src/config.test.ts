import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

// Every env var loadConfig reads. Cleared before each test so the ambient
// environment (or a local .env) can't leak into the assertions, restored after.
const CONFIG_ENV_KEYS = [
  "LLM_PROVIDER",
  "EMBEDDING_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AWS_REGION",
  "BEDROCK_LLM_MODEL",
  "BEDROCK_EMBEDDING_MODEL",
  "ANTHROPIC_LLM_MODEL",
  "OPENAI_LLM_MODEL",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS",
  "VECTOR_PROVIDER",
  "DATABASE_URL",
  "PG_CA_PATH",
  "CRAWL_INTERVAL_MINUTES",
  "CRAWL_TIMEOUT_MS",
  "USER_AGENT",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_APP_TOKEN",
  "SLACK_ALERT_CHANNEL",
  "SIGNIFICANCE_THRESHOLD",
  "PORT",
  "NODE_ENV",
  "LOG_LEVEL",
] as const;

describe("loadConfig", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of CONFIG_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of CONFIG_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("applies defaults with an empty environment", () => {
    const c = loadConfig();
    expect(c.llmProvider).toBe("bedrock");
    expect(c.embeddingProvider).toBe("bedrock");
    expect(c.vectorProvider).toBe("memory");
    expect(c.significanceThreshold).toBe(0.3);
    expect(c.slackAlertChannel).toBe("#competitive-intel");
    expect(c.port).toBe(3000);
    expect(c.nodeEnv).toBe("development");
  });

  it("coerces numeric env vars", () => {
    process.env.CRAWL_INTERVAL_MINUTES = "15";
    process.env.PORT = "8080";
    process.env.EMBEDDING_DIMENSIONS = "1536";
    const c = loadConfig();
    expect(c.crawlIntervalMinutes).toBe(15);
    expect(c.port).toBe(8080);
    expect(c.embeddingDimensions).toBe(1536);
  });

  // ── superRefine: direct-API providers require their key ──────────────────

  it("requires ANTHROPIC_API_KEY when LLM_PROVIDER=anthropic", () => {
    process.env.LLM_PROVIDER = "anthropic";
    expect(() => loadConfig()).toThrow(/ANTHROPIC_API_KEY is required/);
  });

  it("accepts LLM_PROVIDER=anthropic when the key is present", () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(loadConfig().llmProvider).toBe("anthropic");
  });

  it("requires OPENAI_API_KEY when LLM_PROVIDER=openai", () => {
    process.env.LLM_PROVIDER = "openai";
    expect(() => loadConfig()).toThrow(/OPENAI_API_KEY is required when LLM_PROVIDER=openai/);
  });

  it("requires OPENAI_API_KEY when EMBEDDING_PROVIDER=openai", () => {
    process.env.EMBEDDING_PROVIDER = "openai";
    expect(() => loadConfig()).toThrow(/OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai/);
  });

  it("needs no key for the default Bedrock providers (AWS credential chain)", () => {
    expect(() => loadConfig()).not.toThrow();
  });

  // ── superRefine: Slack HTTP mode needs a signing secret ──────────────────

  it("requires a signing secret in Slack HTTP mode (bot token, no app token)", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    expect(() => loadConfig()).toThrow(/SLACK_SIGNING_SECRET is required in HTTP mode/);
  });

  it("accepts Slack Socket Mode (bot token + app token, no signing secret)", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    expect(loadConfig().slackAppToken).toBe("xapp-test");
  });

  it("accepts Slack HTTP mode when the signing secret is present", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SIGNING_SECRET = "shhh";
    expect(loadConfig().slackSigningSecret).toBe("shhh");
  });
});
