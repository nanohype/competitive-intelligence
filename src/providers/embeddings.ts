import type { Config } from "../config.js";
import { createBreaker } from "../resilience/circuit-breaker.js";
import { createRegistry } from "../vendor/runtime/registry.js";

// Hard deadlines for every embedding call — embeddings run sequentially on the
// single-writer crawl path, so a hung call stalls the whole crawl. See llm.ts.
const EMBED_TIMEOUT_MS = 30_000;

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

export const embeddingRegistry = createRegistry<EmbeddingProvider>("embedding");

/** The subset of the OpenAI embeddings response this provider reads. */
interface EmbeddingsResponse {
  data: { index: number; embedding: number[] }[];
}

// ─── The Platform's ModelGateway ───

/**
 * Embeds through the ModelGateway's embeddings route.
 *
 * The gateway exposes the OpenAI embeddings shape on `/v1/embeddings` and
 * translates it to a Bedrock Titan `InvokeModel` call, so the vectors are the
 * same Titan vectors as before — this app just no longer holds AWS credentials
 * or names a model.
 *
 * Two properties of that translation are load-bearing and were checked against
 * its source rather than assumed:
 *
 *   - `dimensions` is forwarded to Titan. It has to be: the pgvector column is
 *     declared at this width, so a dropped value would produce vectors the
 *     store rejects.
 *   - `normalize` is not forwarded, and Titan defaults it to true — which is
 *     what this app asked for explicitly before. Vector semantics are unchanged.
 *
 * Requests are sent one input at a time because the translator rejects a batch
 * outright ("AWS Bedrock Titan does not support batch embeddings"). That is not
 * a regression: Titan's own API is single-input, so the direct path was already
 * looping.
 */
class GatewayEmbeddingProvider implements EmbeddingProvider {
  private breaker = createBreaker("model-gateway-embeddings", { failureThreshold: 3 });
  private endpoint: string;
  private route: string;
  readonly dimensions: number;

  constructor(endpoint: string, route: string, dimensions: number) {
    // Trailing slash trimmed so the joined path cannot end up doubled.
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.route = route;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embedOne(text));
    }
    return results;
  }

  private async embedOne(text: string): Promise<number[]> {
    return this.breaker.exec(async () => {
      const response = await fetch(`${this.endpoint}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // A route name, not a model id — the gateway rewrites it upstream.
          model: this.route,
          input: text,
          dimensions: this.dimensions,
        }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Include the body: the gateway reports a translation refusal (an
        // unmatched route, a batch it will not accept) in it, and without the
        // text those are indistinguishable from an upstream model failure.
        const detail = await response.text().catch(() => "");
        throw new Error(
          `model gateway embeddings failed: ${response.status} ${response.statusText}${
            detail ? ` — ${detail.slice(0, 300)}` : ""
          }`,
        );
      }

      const body = (await response.json()) as EmbeddingsResponse;
      const embedding = body.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("model gateway returned an embeddings response with no vector");
      }
      if (embedding.length !== this.dimensions) {
        // The pgvector column is declared at this width, so a mismatch is
        // rejected at insert — far from the cause. Fail at the source instead.
        throw new Error(
          `model gateway returned a ${embedding.length}-dimension vector, expected ${this.dimensions}`,
        );
      }
      return embedding;
    });
  }
}

// ─── Bootstrap ───

export function bootstrapEmbeddings(config: Config): EmbeddingProvider {
  embeddingRegistry.register(
    "gateway",
    () =>
      new GatewayEmbeddingProvider(
        config.modelGatewayEndpoint,
        config.embeddingRoute,
        config.embeddingDimensions,
      ),
  );
  return embeddingRegistry.get("gateway");
}
