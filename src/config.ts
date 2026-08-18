import { z } from "zod";
import "dotenv/config";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]).default("info");

/**
 * Default model ids, exported so the eval tier scores the model this app
 * actually runs. A second literal over in evals/ would drift the moment one
 * side is bumped, and the eval would quietly start measuring something the
 * radar never uses.
 */
export const DEFAULT_LLM_ROUTE = "default";
export const DEFAULT_EMBEDDING_ROUTE = "embeddings";

/**
 * The gateway's native Anthropic Messages base URL.
 *
 * `modelGatewayEndpoint` is the gateway root, and the gateway serves each
 * client-facing API under its own prefix — which prefix applies depends on the
 * wire format being spoken, not on the model behind it. The OpenAI-shaped
 * endpoints sit at the root, which is why the embeddings provider requests
 * `/v1/embeddings` off the endpoint directly; native Anthropic Messages is
 * served at `POST /anthropic/v1/messages`.
 *
 * The Anthropic SDK appends `/v1/messages` to whatever base URL it is given,
 * so it has to be handed the `/anthropic` prefix. Pointed at the root it would
 * request `/v1/messages`, which the gateway routes nowhere: the model name is
 * extracted from the request body by a processor registered per endpoint path,
 * so an unregistered path never gets the `x-ai-eg-model` header the route
 * rules match on. Every call fails, while the Gateway reports healthy.
 */
export function anthropicBaseUrl(gatewayEndpoint: string): string {
  // Trailing slash trimmed so the joined path cannot end up doubled.
  return `${gatewayEndpoint.replace(/\/+$/, "")}/anthropic`;
}

const schema = z
  .object({
    // The Platform's ModelGateway, published on ModelGateway.status.endpoint.
    // Every model call goes here: the gateway holds the AWS identity, applies
    // the route's guardrail and rate limit, and records the request.
    modelGatewayEndpoint: z
      .string()
      .url()
      // .url() alone accepts any scheme, so a bare `host:8080` parses as a URL
      // whose protocol is `host:`. Both the Messages client and fetch need an
      // http(s) base, and would otherwise fail at request time rather than here.
      .refine((v) => /^https?:\/\//.test(v), {
        message: "MODEL_GATEWAY_ENDPOINT must be an http(s) URL",
      }),
    // Route names on that gateway, not model ids. The ModelGateway CR maps each
    // to a concrete Bedrock model, so switching models is a CR edit and the
    // model never appears in this app's configuration.
    llmRoute: z.string().default(DEFAULT_LLM_ROUTE),
    embeddingRoute: z.string().default(DEFAULT_EMBEDDING_ROUTE),

    // The width of the pgvector column, forwarded to the embeddings route.
    embeddingDimensions: z.number().default(1024),

    vectorProvider: z.enum(["memory", "pgvector"]).default("memory"),
    databaseUrl: z.string().optional(),
    // Path to a mounted CA bundle (e.g. the Amazon RDS global CA) for verifying
    // the pgvector TLS connection. Unset → Node's built-in trust store.
    pgCaPath: z.string().optional(),

    crawlIntervalMinutes: z.number().default(60),
    crawlTimeoutMs: z.number().default(30_000),
    userAgent: z.string().default("competitive-intelligence/0.1.0"),

    // Outbound alert sink — posts the radar's Block Kit alerts to Slack via
    // @slack/web-api. Absent → alerts log only (CLI / local dev).
    slackBotToken: z.string().optional(),
    slackAlertChannel: z.string().default("#competitive-intel"),

    significanceThreshold: z.number().min(0).max(1).default(0.3),

    port: z.number().default(3000),
    // MCP streamable-HTTP server port — the pull/query surface Claude reaches
    // over the mcp-tunnel. Separate from `port` (the /health+/readyz server).
    mcpPort: z.number().default(3001),

    // ─── MCP OAuth 2.1 resource-server protection (optional) ───
    // `none` (default) → the MCP port stays open, protected by the mcp-tunnel +
    // NetworkPolicy alone. `workos` → the port enforces a WorkOS AuthKit bearer
    // token (RFC 9728 / RFC 8707), so it can be added as a Claude custom
    // connector over a public tunnel. The authorization server is WorkOS,
    // configured in their dashboard — this app is only the resource server.
    mcpAuth: z.enum(["none", "workos"]).default("none"),
    // WorkOS AuthKit issuer, e.g. https://your-app.authkit.app — both the `iss`
    // the token must carry and the base its JWKS is fetched from.
    workosAuthkitIssuer: z.string().url().optional(),
    // This server's canonical public URL including the /mcp path. The RFC 8707
    // resource indicator and the `aud` every accepted token must carry.
    mcpPublicUrl: z.string().url().optional(),
    // Optional space/comma-delimited scopes every request must present.
    mcpAuthScopes: z.string().optional(),

    nodeEnv: z.enum(["development", "production", "test"]).default("development"),
    logLevel: logLevelSchema,
  })
  .superRefine((data, ctx) => {
    // The gateway needs no key: it authenticates to Bedrock with its own Pod
    // Identity credentials, and this app holds no model credential at all.

    // WorkOS resource-server protection needs both the issuer (to verify the
    // token) and this server's canonical URI (the audience it must be bound to).
    if (data.mcpAuth === "workos") {
      if (!data.workosAuthkitIssuer) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "WORKOS_AUTHKIT_ISSUER is required when MCP_AUTH=workos",
          path: ["workosAuthkitIssuer"],
        });
      }
      if (!data.mcpPublicUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "MCP_PUBLIC_URL is required when MCP_AUTH=workos (the token audience)",
          path: ["mcpPublicUrl"],
        });
      }
    }
  });

export type Config = z.infer<typeof schema>;

function num(val: string | undefined): number | undefined {
  return val ? Number(val) : undefined;
}

export function loadConfig(): Config {
  return schema.parse({
    modelGatewayEndpoint: process.env.MODEL_GATEWAY_ENDPOINT,
    llmRoute: process.env.LLM_ROUTE,
    embeddingRoute: process.env.EMBEDDING_ROUTE,
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
    mcpAuth: process.env.MCP_AUTH,
    // `|| undefined` so a chart-rendered empty string ("") reads as unset rather
    // than a defined-but-empty value that would fail the `.url()` check.
    workosAuthkitIssuer: process.env.WORKOS_AUTHKIT_ISSUER || undefined,
    mcpPublicUrl: process.env.MCP_PUBLIC_URL || undefined,
    mcpAuthScopes: process.env.MCP_AUTH_SCOPES || undefined,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
  });
}
