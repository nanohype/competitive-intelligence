import type { App } from "@slack/bolt";
import type { IntelEngine } from "../intel/index.js";
import { logger } from "../logger.js";

/**
 * Register Slack event handlers.
 * Responds to @mentions with intelligence queries.
 */
export function registerHandlers(app: App, intel: IntelEngine): void {
  // Handle @mentions — treat the message as a competitive intelligence query
  app.event("app_mention", async ({ event, say }) => {
    const question = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

    if (!question) {
      await say({
        text: "Ask me anything about your competitors. Try: _What has Acme shipped recently?_",
        thread_ts: event.ts,
      });
      return;
    }

    logger.info("query via mention", { user: event.user, question });

    try {
      // Best-effort competitor name extraction from natural language.
      // Matches "about X", "from X", "on X" — works for "tell me about aws"
      // but will misfire on "what changed on the pricing page" (extracts "the").
      // The vector store search still works without a competitor filter, so
      // false extractions degrade gracefully to unfiltered search.
      const competitorMatch = question.match(/\b(?:about|from|on)\s+(\w+)/i);
      const competitor = competitorMatch?.[1]?.toLowerCase();

      const answer = await intel.query(question, { competitor });

      await say({
        text: answer,
        thread_ts: event.ts,
      });
    } catch (err) {
      logger.error("query failed", { error: err instanceof Error ? err.message : String(err) });
      await say({
        text: "Something went wrong processing that query. Check the logs for details.",
        thread_ts: event.ts,
      });
    }
  });

  // Handle direct messages
  app.message(async ({ message, say }) => {
    if (message.subtype) return; // skip bot messages, edits, etc.
    if (!("text" in message) || !message.text) return;

    const question = message.text.trim();
    if (!question) return;

    logger.info("query via DM", { user: "user" in message ? message.user : "unknown", question });

    try {
      const answer = await intel.query(question);
      await say({ text: answer });
    } catch (err) {
      logger.error("DM query failed", { error: err instanceof Error ? err.message : String(err) });
      await say({ text: "Something went wrong. Check the logs." });
    }
  });
}
