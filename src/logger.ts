/**
 * Structured JSON logging to stderr — stdout stays clean for CLI display.
 *
 * The emission core (JSON lines, level filtering, OTel trace_id/span_id
 * correlation from the active span) is the vendored `@nanohype/runtime`
 * logger; this file keeps the app's message-first call shape
 * (`logger.info('crawl done', { sourceId })`) over it.
 */
import { createLogger, errorMessage, type LogLevel } from "./vendor/runtime/logger.js";

export type { LogLevel };

const base = createLogger();

export function setLogLevel(level: LogLevel): void {
  base.setLevel(level);
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => base.debug(data ?? {}, msg),
  info: (msg: string, data?: Record<string, unknown>) => base.info(data ?? {}, msg),
  warn: (msg: string, data?: Record<string, unknown>) => base.warn(data ?? {}, msg),
  error: (msg: string, data?: Record<string, unknown>) => base.error(data ?? {}, msg),
};

/** Normalize an unknown thrown value to a string message. */
export const toMessage = errorMessage;
