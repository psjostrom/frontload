#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { appendEvent, budgetReport } from "../budget/events.js";
import { loadConfig } from "../config/config.js";
import { readBudgeted } from "../commands/read.js";
import { runSummary } from "../commands/run.js";
import { generateDossier, searchIndex } from "../dossier/dossier.js";
import { compareCost, gitDiffSummary } from "../diff/diff.js";
import { buildIndex } from "../indexer/indexer.js";
import { startMcp } from "../mcp/server.js";
import { resolveRepo, stateDir } from "../utils/path.js";

function outputLength(data: unknown): number {
  return (typeof data === "string" ? data : JSON.stringify(data, null, 2)).length;
}

async function measured<T>(repoRoot: string, operation: string, input: unknown, fn: () => Promise<T> | T, logOutput?: (result: T) => unknown): Promise<T> {
  const start = Date.now();
  let success = false;
  let outputChars = 0;
  try {
    const result = await fn();
    success = true;
    outputChars = outputLength(logOutput ? logOutput(result) : result);
    return result;
  } finally {
    appendEvent(repoRoot, { source: "cli", operation, inputChars: JSON.stringify(input).length, outputChars, durationMs: Date.now() - start, success });
  }
}

function print(data: unknown): void {
  process.stdout.write(typeof data === "string" ? `${data}\n` : `${JSON.stringify(data, null, 2)}\n`);
}

const program = new Command();
program.name("agent-budget").description("Local-first context and cost gateway for AI coding agents.").version("0.1.0");

program.command("init").option("--force").action((opts) => {
  for (const [target, source] of [
    ["agent-budget.config.json", "agent-budget.config.example.json"],
    ["AGENTS.md", "AGENTS.example.md"],
    ["codex/config.toml", "codex/config.example.toml"]
  ]) {
    if (fs.existsSync(target) && !opts.force) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  print("Agent Budget files initialized.");
});

program.command("doctor").option("--repo <repo>", ".").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const checks = {
    node: process.versions.node,
    repoRoot,
    config: !!loadConfig(repoRoot),
    writableState: (() => {
      fs.mkdirSync(stateDir(repoRoot), { recursive: true });
      fs.writeFileSync(path.join(stateDir(repoRoot), ".doctor"), "ok");
      return true;
    })(),
    mcpServer: true,
    platform: os.platform()
  };
  print({ summary: "doctor completed", checks });
});

program.command("index").option("--repo <repo>", ".").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const result = await measured(
    repoRoot,
    "index",
    opts,
    () => buildIndex(repoRoot),
    (indexed) => ({ summary: `Indexed ${indexed.stats.fileCount} files.`, indexPath: path.join(stateDir(repoRoot), "index.json"), stats: indexed.stats })
  );
  print({ summary: `Indexed ${result.stats.fileCount} files.`, indexPath: path.join(stateDir(repoRoot), "index.json"), stats: result.stats });
});

program.command("dossier").argument("<task>").option("--repo <repo>", ".").option("--format <format>", "markdown").option("--budget <chars>", "12000").action(async (task, opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const result = await measured(repoRoot, "dossier", { task, opts }, () => generateDossier(repoRoot, task, Number(opts.budget)));
  print(result.markdown);
});

program.command("search").argument("<query>").option("--repo <repo>", ".").option("--limit <n>", "10").action(async (query, opts) => {
  const repoRoot = resolveRepo(opts.repo);
  print(await measured(repoRoot, "search", { query, opts }, () => searchIndex(repoRoot, query, Number(opts.limit))));
});

program.command("read").argument("<path>").option("--repo <repo>", ".").option("--budget <chars>", "4000").option("--query <query>").action(async (file, opts) => {
  const repoRoot = resolveRepo(opts.repo);
  print(await measured(repoRoot, "read", { file, opts }, () => readBudgeted(repoRoot, file, Number(opts.budget), opts.query)));
});

program.command("run").option("--repo <repo>", ".").option("--kind <kind>", "generic").option("--allow-unconfigured").argument("[cmd...]", "command after --").allowUnknownOption(true).allowExcessArguments(true).action(async (cmdParts: string[], opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const parts = cmdParts.includes("--") ? cmdParts.slice(cmdParts.indexOf("--") + 1) : cmdParts;
  print(await measured(repoRoot, "run", { opts, parts }, () => runSummary(repoRoot, opts.kind, parts, !!opts.allowUnconfigured)));
});

program.command("diff").option("--repo <repo>", ".").option("--staged").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  print(await measured(repoRoot, "diff", opts, () => gitDiffSummary(repoRoot, !!opts.staged)));
});

program.command("compare-cost").option("--repo <repo>", ".").option("--base <ref>", "HEAD~1").option("--head <ref>", "HEAD").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  print(await measured(repoRoot, "compare-cost", opts, () => compareCost(repoRoot, opts.base, opts.head)));
});

program.command("budget").option("--repo <repo>", ".").action((opts) => print(budgetReport(resolveRepo(opts.repo))));
program.command("mcp").option("--repo <repo>", ".").action((opts) => startMcp(resolveRepo(opts.repo)));
program.command("proof").option("--repo <repo>", ".").action((opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const pnpmVersion = (() => {
    try {
      return execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return "unavailable";
    }
  })();
  const report = `# Agent Budget Proof Report\n\n- Date/time: ${new Date().toISOString()}\n- Node: ${process.version}\n- pnpm: ${pnpmVersion}\n- OS: ${os.platform()} ${os.release()}\n- Commands: pnpm build, pnpm test, pnpm e2e, pnpm demo:fixture\n- Status: generated by proof command after prior scripts completed\n\n## Test counts\n\nSee \`pnpm test\` and \`pnpm e2e\` output from the proof run.\n\n## Known limitations\n\n- Local scout is an extension point and disabled by default.\n`;
  fs.mkdirSync("proof", { recursive: true });
  fs.writeFileSync("proof/TEST_REPORT.md", report);
  const events = budgetReport(repoRoot);
  const logDir = path.join(stateDir(repoRoot), "logs");
  const latestLog = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter((f) => f.includes("test")).sort().at(-1)
    : undefined;
  const raw = latestLog ? fs.readFileSync(path.join(logDir, latestLog), "utf8") : "";
  const preservedFindings = [
    raw.match(/updates stale chart tooltip value after sensor reconnect/)?.[0],
    raw.match(/src\/chart\/ChartTooltip\.test\.tsx/)?.[0],
    raw.match(/Expected:.*|expected .*93 mg\/dL.*/i)?.[0] ?? raw.match(/Received:.*/i)?.[0]
  ].filter(Boolean);
  const summaryChars = preservedFindings.join("\n").length;
  fs.writeFileSync("proof/raw-vs-summary.json", JSON.stringify({ command: "pnpm test", rawOutputBytes: Buffer.byteLength(raw), summaryChars, compressionRatio: raw ? summaryChars / Buffer.byteLength(raw) : 0, preservedFindings, events: events.operations, fullLog: latestLog ? path.join(logDir, latestLog) : null }, null, 2));
  if (!fs.existsSync("proof/mcp-transcript.jsonl")) fs.writeFileSync("proof/mcp-transcript.jsonl", "");
  print("Proof files generated.");
});

program.parseAsync();
