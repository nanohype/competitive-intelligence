import { z } from 'zod';
import 'dotenv/config';

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']).default('info');

const schema = z
  .object({
    llmProvider: z.enum(['bedrock', 'anthropic', 'openai']).default('bedrock'),
    embeddingProvider: z.enum(['bedrock', 'openai']).default('bedrock'),
    anthropicApiKey: z.string().optional(),
    openaiApiKey: z.string().optional(),

    awsRegion: z.string().default('us-east-1'),
    bedrockLlmModel: z.string().default('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    bedrockEmbeddingModel: z.string().default('amazon.titan-embed-text-v2:0'),

    // Direct-API model IDs for the non-Bedrock providers (injectable, not
    // hardcoded). Anthropic-direct uses the bare current Sonnet alias.
    anthropicLlmModel: z.string().default('claude-sonnet-4-6'),
    openaiLlmModel: z.string().default('gpt-4o'),

    embeddingModel: z.string().default('text-embedding-3-small'),
    embeddingDimensions: z.number().default(1024),

    vectorProvider: z.enum(['memory', 'pgvector']).default('memory'),
    databaseUrl: z.string().optional(),
    // Path to a mounted CA bundle (e.g. the Amazon RDS global CA) for verifying
    // the pgvector TLS connection. Unset → Node's built-in trust store.
    pgCaPath: z.string().optional(),

    crawlIntervalMinutes: z.number().default(60),
    crawlTimeoutMs: z.number().default(30_000),
    userAgent: z.string().default('competitive-intelligence/0.1.0'),

    // Outbound alert sink — posts the radar's Block Kit alerts to Slack via
    // @slack/web-api. Absent → alerts log only (CLI / local dev).
    slackBotToken: z.string().optional(),
    slackAlertChannel: z.string().default('#competitive-intel'),

    significanceThreshold: z.number().min(0).max(1).default(0.3),

    port: z.number().default(3000),
    // MCP streamable-HTTP server port — the pull/query surface Claude reaches
    // over the mcp-tunnel. Separate from `port` (the /health+/readyz server).
    mcpPort: z.number().default(3001),
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
    logLevel: logLevelSchema,
  })
  .superRefine((data, ctx) => {
    // Direct API providers require their keys
    if (data.llmProvider === 'anthropic' && !data.anthropicApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic',
        path: ['anthropicApiKey'],
      });
    }
    if (data.llmProvider === 'openai' && !data.openaiApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai',
        path: ['openaiApiKey'],
      });
    }
    if (data.embeddingProvider === 'openai' && !data.openaiApiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai',
        path: ['openaiApiKey'],
      });
    }
    // Bedrock uses AWS credential chain — no key validation needed
  });

export type Config = z.infer<typeof schema>;

function num(val: string | undefined): number | undefined {
  return val ? Number(val) : undefined;
}

export function loadConfig(): Config {
  return schema.parse({
    llmProvider: process.env.LLM_PROVIDER,
    embeddingProvider: process.env.EMBEDDING_PROVIDER,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    awsRegion: process.env.AWS_REGION,
    bedrockLlmModel: process.env.BEDROCK_LLM_MODEL,
    bedrockEmbeddingModel: process.env.BEDROCK_EMBEDDING_MODEL,
    anthropicLlmModel: process.env.ANTHROPIC_LLM_MODEL,
    openaiLlmModel: process.env.OPENAI_LLM_MODEL,
    embeddingModel: process.env.EMBEDDING_MODEL,
    embeddingDimensions: num(process.env.EMBEDDING_DIMENSIONS),
    vectorProvider: process.env.VECTOR_PROVIDER,
    databaseUrl: process.env.DATABASE_URL,
    pgCaPath: process.env.PG_CA_PATH,
    crawlIntervalMinutes: num(process.env.CRAWL_INTERVAL_MINUTES),
    crawlTimeoutMs: num(process.env.CRAWL_TIMEOUT_MS),
    userAgent: process.env.USER_AGENT,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAlertChannel: process.env.SLACK_ALERT_CHANNEL,
    significanceThreshold: num(process.env.SIGNIFICANCE_THRESHOLD),
    port: num(process.env.PORT),
    mcpPort: num(process.env.MCP_PORT),
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
  });
}
