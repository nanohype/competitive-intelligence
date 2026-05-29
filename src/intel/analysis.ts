import type { LlmProvider } from "../providers/llm.js";
import type { DiffResult } from "../pipeline/differ.js";
import type { SearchResult } from "../providers/vectors.js";

export interface ChangeAnalysis {
  sourceId: string;
  competitor: string;
  summary: string;
  significance: "low" | "medium" | "high" | "critical";
  signals: string[];
}

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
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1] : trimmed;
}

export async function analyzeChanges(diff: DiffResult, llm: LlmProvider): Promise<ChangeAnalysis> {
  const newContent = diff.newChunks.map((c) => c.text).join("\n---\n");

  const prompt = `Competitor: ${diff.competitor}
Source: ${diff.sourceId}
Change score: ${diff.changeScore.toFixed(2)} (${diff.newChunks.length} new chunks out of ${diff.totalChunks})

New content detected:
${newContent.slice(0, 8000)}`;

  const response = await llm.chat(ANALYSIS_SYSTEM, prompt);

  try {
    const parsed = JSON.parse(stripCodeFences(response.text));
    const validSignificance = ["low", "medium", "high", "critical"] as const;
    const significance = validSignificance.includes(parsed.significance)
      ? (parsed.significance as (typeof validSignificance)[number])
      : "low";

    return {
      sourceId: diff.sourceId,
      competitor: diff.competitor,
      summary: parsed.summary ?? "Analysis unavailable",
      significance,
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
    };
  } catch {
    return {
      sourceId: diff.sourceId,
      competitor: diff.competitor,
      summary: response.text.slice(0, 500),
      significance: "low",
      signals: [],
    };
  }
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

  const prompt = `Question: ${question}

Retrieved intelligence (${context.length} sources):
${contextText}`;

  const response = await llm.chat(QUERY_SYSTEM, prompt);
  return response.text;
}
