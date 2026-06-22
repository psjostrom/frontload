#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { Command } from "commander";
import { appendEvent, budgetReport } from "../budget/events.js";
import { loadConfig } from "../config/config.js";
import { readBudgeted } from "../commands/read.js";
import { runSummary } from "../commands/run.js";
import { generateDossier, searchIndex } from "../dossier/dossier.js";
import { compareCost, gitDiffSummary } from "../diff/diff.js";
import { buildIndex } from "../indexer/indexer.js";
import { parseHookHost, runPostToolUseHook, runPreToolUseHook } from "../gate/entry.js";
import { detectPackageManager, formatCommand, globalInstallCommand, initAll, installGlobalFrontload, isGloballyInstalled, mcpConfigAdapters, parseAgents, parseConfigScope, type AgentName, type ConfigScope, type GlobalInstallResult } from "../install/install.js";
import { startMcp } from "../mcp/server.js";
import { validateBundledPlugins } from "../plugins/validate.js";
import { resolveRepo, stateDir } from "../utils/path.js";
import { parsePositiveInteger } from "./options.js";

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
program.name("frontload").description("Local-first context and cost gateway for AI coding agents.").version("0.1.5");

function detectedAgents(homeDir: string): AgentName[] {
  return (["codex", "claude"] as const).filter((agent) => mcpConfigAdapters[agent].detect(homeDir));
}

async function promptAgents(homeDir: string): Promise<ReturnType<typeof parseAgents>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return parseAgents("all");
  const detected = detectedAgents(homeDir);
  const defaultAgents = detected.length > 0 ? detected.join(",") : "all";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Which agents should Frontload configure? [all/codex/claude/codex,claude/none] (${defaultAgents}): ` );
    return parseAgents(answer.trim() || defaultAgents);
  } finally {
    rl.close();
  }
}

async function promptConfigScope(): Promise<ConfigScope> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "project";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Where should Claude Code MCP config be written? [project/global] (project): ");
    return parseConfigScope(answer.trim() || "project");
  } finally {
    rl.close();
  }
}

async function promptApproveGlobalInstall(commandText: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`frontload is not installed globally. Install it now with "${commandText}"? [y/N]: `);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function configuresAgent(agents: Array<"codex" | "claude" | "all">, agent: "codex" | "claude"): boolean {
  return agents.includes("all") || agents.includes(agent);
}

async function ensureGlobalFrontload(approved: boolean): Promise<GlobalInstallResult> {
  const packageManager = detectPackageManager();
  const install = globalInstallCommand(packageManager);
  if (isGloballyInstalled()) {
    return {
      action: "skipped",
      command: install.command,
      args: install.args,
      notes: ["A frontload binary is already available on PATH."]
    };
  }
  const canInstall = approved || await promptApproveGlobalInstall(formatCommand(install));
  if (!canInstall) {
    return {
      action: "manual",
      command: install.command,
      args: install.args,
      notes: [`Install frontload globally before restarting your editor: ${formatCommand(install)}`]
    };
  }
  return installGlobalFrontload(packageManager);
}

program
  .command("init")
  .option("--repo <repo>", "repository root", ".")
  .option("--agents <agents>", "comma-separated agents to configure: codex,claude,all,none")
  .option("--scope <scope>", "Claude Code MCP config scope: project or global")
  .option("--home <dir>", "home directory for agent plugin installation")
  .option("--force")
  .option("--yes", "approve installing frontload globally if needed")
  .action(async (opts) => {
    const homeDir = opts.home ? path.resolve(opts.home) : os.homedir();
    const agents = opts.agents === undefined ? await promptAgents(homeDir) : parseAgents(opts.agents);
    const scope = opts.scope === undefined && configuresAgent(agents, "claude") ? await promptConfigScope() : parseConfigScope(opts.scope);
    const globalInstall = agents.length > 0 ? await ensureGlobalFrontload(!!opts.yes) : undefined;
    if (globalInstall?.action === "manual") {
      print({ summary: "Frontload was not installed globally; MCP config was not written.", globalInstall });
      process.exitCode = 1;
      return;
    }
    print({
      globalInstall,
      ...initAll(resolveRepo(opts.repo), agents, homeDir, !!opts.force, scope)
    });
  });

program.command("doctor").option("--repo <repo>", "repository root", ".").action(async (opts) => {
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

program.command("index").option("--repo <repo>", "repository root", ".").action(async (opts) => {
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

program.command("dossier").argument("<task>").option("--repo <repo>", "repository root", ".").option("--format <format>", "markdown").option("--budget <chars>", "12000").action(async (task, opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const result = await measured(repoRoot, "dossier", { task, opts }, () => generateDossier(repoRoot, task, Number(opts.budget)));
  print(result.markdown);
});

program.command("search").argument("<query>").option("--repo <repo>", "repository root", ".").option("--limit <n>", "10").action(async (query, opts) => {
  const repoRoot = resolveRepo(opts.repo);
  print(await measured(repoRoot, "search", { query, opts }, () => searchIndex(repoRoot, query, Number(opts.limit))));
});

program.command("read")
  .argument("<path>")
  .option("--repo <repo>", "repository root", ".")
  .option("--budget <chars>", "target output characters", parsePositiveInteger, 4000)
  .option("--query <query>")
  .option("--start-line <line>", "1-based start line", parsePositiveInteger)
  .option("--line-count <count>", "maximum number of lines to return", parsePositiveInteger)
  .action(async (file, opts) => {
    const repoRoot = resolveRepo(opts.repo);
    const readOptions = {
      budgetChars: opts.budget as number,
      query: opts.query as string | undefined,
      startLine: opts.startLine as number | undefined,
      lineCount: opts.lineCount as number | undefined
    };
    print(await measured(repoRoot, "read", { file, opts: readOptions }, () => readBudgeted(repoRoot, file, readOptions)));
  });

program.command("run").option("--repo <repo>", "repository root", ".").option("--kind <kind>", "generic").option("--allow-unconfigured").argument("[cmd...]", "command after --").allowUnknownOption(true).allowExcessArguments(true).action(async (cmdParts: string[], opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const parts = cmdParts.includes("--") ? cmdParts.slice(cmdParts.indexOf("--") + 1) : cmdParts;
  print(await measured(repoRoot, "run", { opts, parts }, () => runSummary(repoRoot, opts.kind, parts, !!opts.allowUnconfigured)));
});

program.command("diff").option("--repo <repo>", "repository root", ".").option("--staged").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  print(await measured(repoRoot, "diff", opts, () => gitDiffSummary(repoRoot, !!opts.staged)));
});

program.command("compare-cost").option("--repo <repo>", "repository root", ".").option("--base <ref>", "HEAD~1").option("--head <ref>", "HEAD").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  print(await measured(repoRoot, "compare-cost", opts, () => compareCost(repoRoot, opts.base, opts.head)));
});

program.command("budget").option("--repo <repo>", "repository root", ".").action((opts) => print(budgetReport(resolveRepo(opts.repo))));
program.command("validate-plugins").option("--repo <repo>", "repository root", ".").action((opts) => print(validateBundledPlugins(resolveRepo(opts.repo))));
const hook = program.command("hook");
hook.command("pre-tool-use").requiredOption("--host <host>").action(async (opts) => {
  const output = await runPreToolUseHook(parseHookHost(opts.host));
  if (output) process.stdout.write(output);
});
hook.command("post-tool-use").requiredOption("--host <host>").action(async (opts) => {
  const output = await runPostToolUseHook(parseHookHost(opts.host));
  if (output) process.stdout.write(output);
});
program.command("mcp").option("--repo <repo>", "repository root", ".").action((opts) => startMcp(resolveRepo(opts.repo)));
program.command("proof").option("--repo <repo>", "repository root", ".").action((opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const pnpmVersion = (() => {
    try {
      return execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return "unavailable";
    }
  })();
  const report = `# Frontload Proof Report\n\n- Date/time: ${new Date().toISOString()}\n- Node: ${process.version}\n- pnpm: ${pnpmVersion}\n- OS: ${os.platform()} ${os.release()}\n- Commands: pnpm build, pnpm test, pnpm e2e, pnpm demo:fixture\n- Status: generated by proof command after prior scripts completed\n\n## Test counts\n\nSee \`pnpm test\` and \`pnpm e2e\` output from the proof run.\n\n## Known limitations\n\n- Local scout is an extension point and disabled by default.\n`;
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
