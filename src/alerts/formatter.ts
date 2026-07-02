import type { ChangeAnalysis } from '../intel/analysis.js';

export interface SlackBlocks {
  blocks: unknown[];
  text: string; // fallback for notifications
}

const SIGNIFICANCE_EMOJI: Record<string, string> = {
  critical: ':rotating_light:',
  high: ':red_circle:',
  medium: ':large_orange_circle:',
  low: ':white_circle:',
};

/**
 * Format a change analysis into Slack Block Kit message.
 */
export function formatAlert(analysis: ChangeAnalysis): SlackBlocks {
  const emoji = SIGNIFICANCE_EMOJI[analysis.significance] ?? ':question:';
  const fallback = `[${analysis.significance.toUpperCase()}] ${analysis.competitor}: ${analysis.summary}`;

  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${analysis.competitor.toUpperCase()} — ${analysis.significance.toUpperCase()}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Source:* \`${analysis.sourceId}\`\n\n${analysis.summary}`,
      },
    },
  ];

  if (analysis.signals.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Signals:*\n${analysis.signals.map((s) => `• ${s}`).join('\n')}`,
      },
    });
  }

  blocks.push({ type: 'divider' });

  return { blocks, text: fallback };
}
