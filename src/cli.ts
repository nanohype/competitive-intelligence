import { loadConfig } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import { bootstrapLlm } from "./providers/llm.js";
import { bootstrapEmbeddings } from "./providers/embeddings.js";
import { bootstrapVectorStore } from "./providers/vectors.js";
import { loadSourcesFromFile } from "./crawler/sources.js";
import { fetchPage } from "./crawler/fetcher.js";
import { parseHtml } from "./crawler/parser.js";
import { ingestAndDiff } from "./pipeline/index.js";
import { createIntelEngine } from "./intel/index.js";
import { createAlertEngine } from "./alerts/index.js";
import type { ParsedContent } from "./crawler/parser.js";
import type { Source } from "./crawler/sources.js";
import * as ui from "./display.js";

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  switch (command) {
    case "crawl": {
      const sources = loadSourcesFromFile("sources.json");

      if (sources.length === 0) {
        console.error("No sources configured. Create a sources.json file.");
        process.exit(1);
      }

      const llm = bootstrapLlm(config);
      const embedder = bootstrapEmbeddings(config);
      const store = bootstrapVectorStore(config);

      ui.header();
      ui.crawlStart(sources);

      // Crawl with per-source progress
      const succeeded: ParsedContent[] = [];
      const failed: Array<{ source: Source; error: string }> = [];

      for (const source of sources) {
        try {
          const result = await fetchPage(source.url, {
            timeoutMs: config.crawlTimeoutMs,
            userAgent: config.userAgent,
          });
          const parsed = parseHtml(result.html, source, result.fetchedAt);
          succeeded.push(parsed);
          ui.crawlSourceResult(source, { ok: true, parsed });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failed.push({ source, error: message });
          ui.crawlSourceResult(source, { ok: false, error: message });
        }
      }

      const crawlResult = { succeeded, failed };

      if (succeeded.length === 0) {
        ui.failuresDetail(failed);
        console.error("\n  All crawls failed. Nothing to process.\n");
        process.exit(1);
      }

      // Pipeline
      const pipeline = await ingestAndDiff(succeeded, embedder, store);
      ui.pipelineSummary(crawlResult, pipeline);

      // Analysis
      const noopSink = { async send() {} };
      const alerts = createAlertEngine(llm, noopSink, config);
      const analyses = await alerts.processDiffs(pipeline.diffs);

      // Display changes
      ui.changesHeader(analyses, config.significanceThreshold);
      for (const a of analyses) {
        ui.changeDetail(a);
      }

      // Failures
      ui.failuresDetail(failed);

      // Summary
      ui.summary(crawlResult, pipeline, analyses, sources.length);
      break;
    }

    case "query": {
      const question = args.join(" ");
      if (!question) {
        console.error("Usage: npm run query -- <question>");
        process.exit(1);
      }

      const llm = bootstrapLlm(config);
      const embedder = bootstrapEmbeddings(config);
      const store = bootstrapVectorStore(config);
      const intel = createIntelEngine(embedder, store, llm);

      ui.header();
      ui.queryHeader(question);

      const answer = await intel.query(question);
      ui.queryAnswer(answer);
      break;
    }

    default: {
      ui.header();
      console.log(`  ${"\x1b[1m"}Commands:${"\x1b[0m"}`);
      console.log(`    crawl              Crawl all sources, detect changes`);
      console.log(`    query <question>   Query the intelligence knowledge base`);
      console.log();
      console.log(`  ${"\x1b[1m"}Examples:${"\x1b[0m"}`);
      console.log(`    npm run crawl`);
      console.log(`    npm run query -- "What has AWS shipped recently?"`);
      console.log(`    npm run query -- "Are any competitors hiring ML engineers?"`);
      console.log();
    }
  }
}

main().catch((err) => {
  logger.error("cli error", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
