import { z } from "zod";
import { logger } from "../logger.js";
import { recordAnalysisParseFailure } from "../metrics.js";
import type { DiffResult } from "../pipeline/differ.js";
import type { LlmProvider } from "../providers/llm.js";
import type { SearchResult } from "../providers/vectors.js";
import { fenceUntrusted, normalizeDelimiters } from "../vendor/runtime/guardrails.js";

export interface ChangeAnalysis {
  sourceId: string;
  competitor: string;
  summary: string;
  significance: "low" | "medium" | "high" | "critical";
  signals: string[];
}

// The model returns JSON — validate it at this trust boundary like every other
// input (config, sources). Unknown shapes fall back to the raw-text branch.
//
// Every field is strict on purpose. `.catch()` on `significance` and `signals`
// used to absorb a malformed value into `low` / `[]` and return the object as
// though the model had answered correctly, which made the one branch that
// reports a parse problem unreachable for everything except non-JSON. A field
// this schema will not accept is a parse failure, exactly as malformed JSON is;
// `safeParseAnalysis` returns null for both and the caller handles them the
// same way.
const analysisSchema = z.object({
  summary: z.string(),
  significance: z.enum(["low", "medium", "high", "critical"]),
  signals: z.array(z.string()),
});

const ANALYSIS_SYSTEM = `You are a competitive intelligence analyst. You analyze changes detected on competitor websites and extract actionable intelligence signals.

Given new content detected on a competitor's page, produce:
1. A concise summary of what changed (2-3 sentences)
2. A significance level: low, medium, high, or critical
3. A list of specific intelligence signals (e.g., "new enterprise tier launched", "hiring 5 ML engineers", "deprecated v1 API")

Respond in JSON format:
{
  "summary": "...",
  "significance": "low|medium|high|critical",
  "signals": ["...", "..."]
}`;

/** Strip markdown code fences (```json ... ```) that LLMs often wrap around JSON. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1] : trimmed;
}

export async function analyzeChanges(diff: DiffResult, llm: LlmProvider): Promise<ChangeAnalysis> {
  const newContent = diff.newChunks.map((c) => c.text).join("\n---\n");

  // The crawled page is the least trustworthy input in this system. It is a
  // competitor's own website — someone who can notice they are being crawled
  // and serve whatever they like to the crawler. Concatenating it raw would
  // put their text in the same channel as the analyst instructions above it,
  // with nothing marking where one ends and the other begins.
  //
  // Fencing does not make the model refuse; it gives it what it needs to.
  // evals/analysis.eval.ts measures whether it actually does, on these
  // prompts, against a real model.
  const prompt = `Competitor: ${diff.competitor}
Source: ${diff.sourceId}
Change score: ${diff.changeScore.toFixed(2)} (${diff.newChunks.length} new chunks out of ${diff.totalChunks})

New content detected:
${fenceUntrusted(newContent.slice(0, 8000), "crawled page content")}`;

  const response = await llm.chat(ANALYSIS_SYSTEM, prompt);

  const parsed = safeParseAnalysis(stripCodeFences(response.text), {
    sourceId: diff.sourceId,
    competitor: diff.competitor,
  });
  if (parsed) {
    return {
      sourceId: diff.sourceId,
      competitor: diff.competitor,
      summary: parsed.summary,
      significance: parsed.significance,
      signals: parsed.signals,
    };
  }

  // The model did not answer in the contract — not JSON, or JSON the schema
  // rejects. Fall back to its raw text as the summary. `low` here is the
  // absence of a severity judgement rather than a judgement of "low", which is
  // why `safeParseAnalysis` counts the event: downstream this value is
  // indistinguishable from a model that looked and found nothing.
  return {
    sourceId: diff.sourceId,
    competitor: diff.competitor,
    summary: response.text.slice(0, 500),
    significance: "low",
    signals: [],
  };
}

/**
 * Parse + validate the model's analysis JSON; null when it is not JSON, or is
 * JSON the schema rejects. Both are the same event to the caller — the model did
 * not answer in the contract — and both are counted, because the fallback the
 * caller then takes is indistinguishable from a genuine low-significance result.
 */
function safeParseAnalysis(
  text: string,
  context: { sourceId: string; competitor: string },
): z.infer<typeof analysisSchema> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    logger.warn("analysis response was not JSON — falling back to raw text", context);
    recordAnalysisParseFailure("not_json");
    return null;
  }
  const result = analysisSchema.safeParse(json);
  if (!result.success) {
    logger.warn("analysis response did not match the schema — falling back to raw text", {
      ...context,
      issues: result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    });
    recordAnalysisParseFailure("schema");
    return null;
  }
  return result.data;
}

// ─── Query answering ───

const QUERY_SYSTEM = `You are a competitive intelligence analyst. Answer questions about competitors using the retrieved context from monitored sources. Be specific, cite what you know, and flag uncertainty. If the context doesn't contain the answer, say so.`;

export async function answerQuery(
  question: string,
  context: SearchResult[],
  llm: LlmProvider,
): Promise<string> {
  const contextText = context
    .map(
      (r, i) =>
        `[${i + 1}] (${r.metadata.competitor} — ${r.metadata.type}, score: ${r.score.toFixed(2)})\n${r.content}`,
    )
    .join("\n\n");

  // Retrieval is the injection channel people forget. Every chunk here came
  // from a crawled competitor page, so a page written to be retrieved gets
  // its text into this prompt on someone else's question — the attacker never
  // has to be the caller.
  //
  // The whole block is fenced as one span, provenance headers included. That
  // means a chunk can forge a `[2] (othercorp — pricing)` line and mislabel
  // itself, which is acceptable here precisely because everything inside the
  // fence is data: the headers are navigational, not authority. Fencing each
  // chunk separately would put the labels outside, and is the shape to reach
  // for if provenance ever becomes load-bearing.
  //
  // The question is not fenced: it IS the task, and wrapping it in "treat as
  // data" would be nonsense. It is delimiter-normalized instead, so a
  // question containing `<system>` can't restructure the prompt around it.
  const prompt = `Question: ${normalizeDelimiters(question)}

Retrieved intelligence (${context.length} sources):
${fenceUntrusted(contextText, "retrieved source content")}`;

  const response = await llm.chat(QUERY_SYSTEM, prompt);
  return response.text;
}
