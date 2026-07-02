import type { DiffResult } from '../pipeline/differ.js';
import type { LlmProvider } from '../providers/llm.js';
import type { Config } from '../config.js';
import { analyzeChanges, type ChangeAnalysis } from '../intel/analysis.js';
import { formatAlert, type SlackBlocks } from './formatter.js';
import { logger, toMessage } from '../logger.js';
import { recordAlertSendFailure, recordAlertFired } from '../metrics.js';

export interface AlertSink {
  send(channel: string, message: SlackBlocks): Promise<void>;
}

export interface AlertEngine {
  processDiffs(diffs: DiffResult[]): Promise<ChangeAnalysis[]>;
}

/**
 * Alert engine: analyze diffs for significance, send alerts for meaningful changes.
 */
export function createAlertEngine(llm: LlmProvider, sink: AlertSink, config: Config): AlertEngine {
  return {
    async processDiffs(diffs) {
      const analyses: ChangeAnalysis[] = [];

      for (const diff of diffs) {
        // Skip sources with no meaningful change
        if (diff.changeScore < config.significanceThreshold) {
          logger.debug('below threshold, skipping', {
            sourceId: diff.sourceId,
            changeScore: diff.changeScore,
            threshold: config.significanceThreshold,
          });
          continue;
        }

        if (diff.newChunks.length === 0) continue;

        // Analyze with LLM
        const analysis = await analyzeChanges(diff, llm);
        analyses.push(analysis);

        // Send alert
        const message = formatAlert(analysis);
        try {
          await sink.send(config.slackAlertChannel, message);
          recordAlertFired();
          logger.info('alert sent', {
            sourceId: analysis.sourceId,
            significance: analysis.significance,
            channel: config.slackAlertChannel,
          });
        } catch (err) {
          recordAlertSendFailure(analysis.sourceId);
          logger.error('alert send failed', {
            sourceId: analysis.sourceId,
            error: toMessage(err),
          });
        }
      }

      return analyses;
    },
  };
}
