import { loadConfig } from './config.js';
import { logger, setLogLevel, toMessage } from './logger.js';
import { bootstrapLlm } from './providers/llm.js';
import { bootstrapEmbeddings } from './providers/embeddings.js';
import { bootstrapVectorStore } from './providers/vectors.js';
import { loadSourcesFromFile } from './crawler/sources.js';
import { crawlAll } from './crawler/index.js';
import { ingestAndDiff } from './pipeline/index.js';
import { createIntelEngine } from './intel/index.js';
import { createAlertEngine } from './alerts/index.js';
import * as ui from './display.js';

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  switch (command) {
    case 'crawl': {
      const sources = loadSourcesFromFile('sources.json');

      if (sources.length === 0) {
        console.error('No sources configured. Create a sources.json file.');
        process.exit(1);
      }

      const llm = bootstrapLlm(config);
      const embedder = bootstrapEmbeddings(config);
      const store = bootstrapVectorStore(config);

      ui.header();
      ui.crawlStart(sources);

      // Reuse the shared crawl loop, streaming per-source progress through the
      // callback instead of duplicating fetch→parse→collect here.
      const crawlResult = await crawlAll(sources, {
        timeoutMs: config.crawlTimeoutMs,
        userAgent: config.userAgent,
        onResult: ui.crawlSourceResult,
      });

      if (crawlResult.succeeded.length === 0) {
        ui.failuresDetail(crawlResult.failed);
        console.error('\n  All crawls failed. Nothing to process.\n');
        process.exit(1);
      }

      // Pipeline
      const pipeline = await ingestAndDiff(crawlResult.succeeded, embedder, store);
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
      ui.failuresDetail(crawlResult.failed);

      // Summary
      ui.summary(crawlResult, pipeline, analyses, sources.length);
      break;
    }

    case 'query': {
      const question = args.join(' ');
      if (!question) {
        console.error('Usage: npm run query -- <question>');
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
      console.log(`  ${'\x1b[1m'}Commands:${'\x1b[0m'}`);
      console.log(`    crawl              Crawl all sources, detect changes`);
      console.log(`    query <question>   Query the intelligence knowledge base`);
      console.log();
      console.log(`  ${'\x1b[1m'}Examples:${'\x1b[0m'}`);
      console.log(`    npm run crawl`);
      console.log(`    npm run query -- "What has AWS shipped recently?"`);
      console.log(`    npm run query -- "Are any competitors hiring ML engineers?"`);
      console.log();
    }
  }
}

main().catch((err) => {
  logger.error('cli error', { error: toMessage(err) });
  process.exit(1);
});
