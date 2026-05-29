import type { ChangeAnalysis } from "./intel/analysis.js";
import type { CrawlResult } from "./crawler/index.js";
import type { PipelineResult } from "./pipeline/index.js";
import type { Source } from "./crawler/sources.js";
import type { ParsedContent } from "./crawler/parser.js";

// ─── ANSI helpers ───

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgWhite: "\x1b[47m",
};

const W = 58; // box width

function box(title: string, lines: string[]): string {
  const top = `  ${c.gray}┌─${c.reset} ${c.bold}${title}${c.reset} ${c.gray}${"─".repeat(Math.max(0, W - title.length - 4))}┐${c.reset}`;
  const mid = lines.map(
    (l) =>
      `  ${c.gray}│${c.reset} ${l}${" ".repeat(Math.max(0, W - stripAnsi(l).length - 2))}${c.gray}│${c.reset}`,
  );
  const bot = `  ${c.gray}└${"─".repeat(W)}┘${c.reset}`;
  return [top, ...mid, bot].join("\n");
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function kv(label: string, value: string | number, indent = 0): string {
  const pad = " ".repeat(indent);
  return `${pad}${c.gray}${label}:${c.reset} ${c.bold}${value}${c.reset}`;
}

// ─── Severity badge ───

function badge(significance: string): string {
  switch (significance) {
    case "critical":
      return `${c.bgRed}${c.white}${c.bold} CRITICAL ${c.reset}`;
    case "high":
      return `${c.red}${c.bold} HIGH ${c.reset}`;
    case "medium":
      return `${c.yellow}${c.bold} MEDIUM ${c.reset}`;
    case "low":
      return `${c.dim} LOW ${c.reset}`;
    default:
      return ` ${significance.toUpperCase()} `;
  }
}

// ─── Header ───

export function header(): void {
  console.log(
    `\n  ${c.bold}${c.cyan}sigint${c.reset} ${c.dim}— competitive intelligence radar${c.reset}\n`,
  );
}

// ─── Crawl progress ───

export function crawlStart(sources: Source[]): void {
  const competitors = new Set(sources.map((s) => s.competitor));
  console.log(box("Crawl", [`${sources.length} sources across ${competitors.size} competitors`]));
  console.log();
}

export function crawlSourceResult(
  source: Source,
  result: { ok: true; parsed: ParsedContent } | { ok: false; error: string },
): void {
  const label = source.id;
  const dots = "·".repeat(Math.max(1, 36 - label.length));

  if (result.ok) {
    const chars = result.parsed.text.length;
    const size = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : `${chars}`;
    console.log(
      `  ${label} ${c.gray}${dots}${c.reset} ${c.green}✓${c.reset} ${c.dim}${size} chars${c.reset}`,
    );
  } else {
    console.log(
      `  ${label} ${c.gray}${dots}${c.reset} ${c.red}✗${c.reset} ${c.dim}${result.error}${c.reset}`,
    );
  }
}

// ─── Pipeline summary ───

export function pipelineSummary(crawl: CrawlResult, pipeline: PipelineResult): void {
  console.log();
  console.log(
    box("Pipeline", [
      `${crawl.succeeded.length} pages → ${pipeline.totalChunksStored} chunks embedded & stored`,
    ]),
  );
}

// ─── Changes ───

export function changesHeader(analyses: ChangeAnalysis[], threshold: number): void {
  console.log();
  if (analyses.length === 0) {
    console.log(
      box("Changes", [
        `${c.dim}No significant changes detected (threshold: ${threshold.toFixed(2)})${c.reset}`,
      ]),
    );
    return;
  }
  console.log(
    box("Changes", [
      `${c.bold}${analyses.length}${c.reset} significant change${analyses.length > 1 ? "s" : ""} detected ${c.dim}(threshold: ${threshold.toFixed(2)})${c.reset}`,
    ]),
  );
}

export function changeDetail(analysis: ChangeAnalysis): void {
  console.log();
  console.log(
    `  ${badge(analysis.significance)}  ${c.bold}${analysis.competitor.toUpperCase()}${c.reset} ${c.gray}— ${analysis.sourceId}${c.reset}`,
  );
  console.log();

  // Word-wrap summary to terminal width
  const words = analysis.summary.split(" ");
  let line = "  ";
  for (const word of words) {
    if (line.length + word.length > 72) {
      console.log(line);
      line = "  " + word;
    } else {
      line += (line.trim() ? " " : "") + word;
    }
  }
  if (line.trim()) console.log(line);

  if (analysis.signals.length > 0) {
    console.log();
    console.log(`  ${c.bold}Signals:${c.reset}`);
    for (const signal of analysis.signals) {
      console.log(`    ${c.cyan}•${c.reset} ${signal}`);
    }
  }

  console.log();
  console.log(`  ${c.gray}${"─".repeat(54)}${c.reset}`);
}

// ─── Final summary ───

export function summary(
  crawl: CrawlResult,
  pipeline: PipelineResult,
  analyses: ChangeAnalysis[],
  totalSources: number,
): void {
  const bySeverity: Record<string, number> = {};
  for (const a of analyses) {
    bySeverity[a.significance] = (bySeverity[a.significance] ?? 0) + 1;
  }
  const competitors = new Set(analyses.map((a) => a.competitor));
  const totalCompetitors = new Set([
    ...crawl.succeeded.map((p) => p.competitor),
    ...crawl.failed.map((f) => f.source.competitor),
  ]);

  console.log();
  console.log(`  ${c.bold}Summary${c.reset}`);
  console.log(
    `  ${c.gray}├──${c.reset} ${kv("Pages crawled", `${crawl.succeeded.length}/${totalSources}${crawl.failed.length > 0 ? ` (${crawl.failed.length} failed)` : ""}`)}`,
  );
  console.log(`  ${c.gray}├──${c.reset} ${kv("Chunks stored", pipeline.totalChunksStored)}`);

  if (analyses.length > 0) {
    console.log(`  ${c.gray}├──${c.reset} ${kv("Significant changes", analyses.length)}`);
    const severities = ["critical", "high", "medium", "low"] as const;
    const active = severities.filter((s) => bySeverity[s]);
    for (let i = 0; i < active.length; i++) {
      const s = active[i];
      const branch = i < active.length - 1 ? "├" : "└";
      const count = bySeverity[s];
      const colorFn = s === "critical" || s === "high" ? c.red : s === "medium" ? c.yellow : c.dim;
      console.log(
        `  ${c.gray}│   ${branch}──${c.reset} ${colorFn}${s.charAt(0).toUpperCase() + s.slice(1)}: ${count}${c.reset}`,
      );
    }
  } else {
    console.log(`  ${c.gray}├──${c.reset} ${kv("Significant changes", `0`)}`);
  }

  console.log(
    `  ${c.gray}└──${c.reset} ${kv("Competitors active", `${competitors.size} of ${totalCompetitors.size}`)}`,
  );
  console.log();
}

// ─── Query display ───

export function queryHeader(question: string): void {
  console.log(box("Query", [`${c.cyan}"${question}"${c.reset}`]));
  console.log();
}

export function queryAnswer(answer: string): void {
  // Indent the answer text
  const lines = answer.split("\n");
  for (const line of lines) {
    console.log(`  ${line}`);
  }
  console.log();
}

// ─── Failures detail ───

export function failuresDetail(failed: CrawlResult["failed"]): void {
  if (failed.length === 0) return;
  console.log();
  console.log(`  ${c.yellow}${c.bold}Failed sources:${c.reset}`);
  for (const f of failed) {
    console.log(`    ${c.red}✗${c.reset} ${f.source.id} ${c.dim}— ${f.error}${c.reset}`);
  }
}
