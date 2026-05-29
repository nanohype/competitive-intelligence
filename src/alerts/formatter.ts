import type { ChangeAnalysis } from "../intel/analysis.js";

export interface SlackBlocks {
  blocks: unknown[];
  text: string; // fallback for notifications
}

const SIGNIFICANCE_EMOJI: Record<string, string> = {
  critical: ":rotating_light:",
  high: ":red_circle:",
  medium: ":large_orange_circle:",
  low: ":white_circle:",
};

/**
 * Format a change analysis into Slack Block Kit message.
 */
export function formatAlert(analysis: ChangeAnalysis): SlackBlocks {
  const emoji = SIGNIFICANCE_EMOJI[analysis.significance] ?? ":question:";
  const fallback = `[${analysis.significance.toUpperCase()}] ${analysis.competitor}: ${analysis.summary}`;

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} ${analysis.competitor.toUpperCase()} — ${analysis.significance.toUpperCase()}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Source:* \`${analysis.sourceId}\`\n\n${analysis.summary}`,
      },
    },
  ];

  if (analysis.signals.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Signals:*\n${analysis.signals.map((s) => `• ${s}`).join("\n")}`,
      },
    });
  }

  blocks.push({ type: "divider" });

  return { blocks, text: fallback };
}

/**
 * Format a daily/weekly digest of all changes.
 * Currently not wired into the scheduler — intended for a future digest
 * job (e.g., daily summary at 9am). Call with accumulated ChangeAnalysis
 * results and a period label like "2026-04-07" or "Week of Apr 7".
 */
export function formatDigest(analyses: ChangeAnalysis[], period: string): SlackBlocks {
  if (analyses.length === 0) {
    return {
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `_No competitive changes detected during ${period}._` },
        },
      ],
      text: `No competitive changes detected during ${period}.`,
    };
  }

  const byCompetitor = new Map<string, ChangeAnalysis[]>();
  for (const a of analyses) {
    const list = byCompetitor.get(a.competitor) ?? [];
    list.push(a);
    byCompetitor.set(a.competitor, list);
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Competitive Intelligence Digest — ${period}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${analyses.length} change(s)* detected across *${byCompetitor.size} competitor(s)*.`,
      },
    },
    { type: "divider" },
  ];

  for (const [competitor, changes] of byCompetitor) {
    const summary = changes
      .map((c) => {
        const emoji = SIGNIFICANCE_EMOJI[c.significance] ?? "";
        return `${emoji} ${c.summary}`;
      })
      .join("\n");

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${competitor.toUpperCase()}* (${changes.length} change${changes.length > 1 ? "s" : ""})\n${summary}`,
      },
    });
  }

  return {
    blocks,
    text: `Competitive Intelligence Digest: ${analyses.length} changes across ${byCompetitor.size} competitors.`,
  };
}
