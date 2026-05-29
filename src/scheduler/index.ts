import { logger } from "../logger.js";

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

/**
 * Simple interval-based scheduler. Runs jobs on fixed intervals.
 * Each job runs independently — a slow job won't block others.
 */
export function createScheduler(jobs: ScheduledJob[]): Scheduler {
  const timers: NodeJS.Timeout[] = [];

  return {
    start() {
      for (const job of jobs) {
        logger.info("scheduling job", {
          name: job.name,
          intervalMinutes: job.intervalMs / 60_000,
        });

        const timer = setInterval(async () => {
          logger.info("job starting", { name: job.name });
          const start = Date.now();

          try {
            await job.fn();
            logger.info("job completed", {
              name: job.name,
              durationMs: Date.now() - start,
            });
          } catch (err) {
            logger.error("job failed", {
              name: job.name,
              durationMs: Date.now() - start,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, job.intervalMs);

        // Don't prevent process exit
        timer.unref();
        timers.push(timer);
      }

      logger.info("scheduler started", { jobs: jobs.length });
    },

    stop() {
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers.length = 0;
      logger.info("scheduler stopped");
    },
  };
}
