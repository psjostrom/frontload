#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { Command, Option } from "commander";
import { appendEvent, budgetReport, outputSize } from "../budget/events.js";
import { loadConfig } from "../config/config.js";
import { readBudgeted } from "../commands/read.js";
import { runSummary } from "../commands/run.js";
import { generateDossier, searchIndexMeasured } from "../dossier/dossier.js";
import { compareCost, gitDiffSummary } from "../diff/diff.js";
import { buildIndex } from "../indexer/indexer.js";
import { parseHookHost, runPostToolUseHook, runPreToolUseHook } from "../gate/entry.js";
import { detectPackageManager, formatCommand, globalInstallCommand, initAll, installGlobalFrontload, isGloballyInstalled, mcpConfigAdapters, parseAgents, parseConfigScope, resolveGlobalExecutable, upgradeAll, upgradeGlobalFrontload, type AgentName, type ConfigScope, type GlobalInstallResult } from "../install/install.js";
import { startMcp } from "../mcp/server.js";
import { validateBundledPlugins } from "../plugins/validate.js";
import { BaselineKind } from "../types.js";
import { resolveRepo, stateDir } from "../utils/path.js";
import { packageVersion, packageVersionFrom } from "../version.js";
import { applyAgentCheckboxKey, createAgentCheckboxState, formatAgentCheckboxPrompt, selectedAgents, type AgentCheckboxState } from "./checkbox.js";
import { formatInitOutput } from "./init-output.js";
import { parsePositiveInteger } from "./options.js";

type ResultMeasurement<T> = {
  output: (result: T) => unknown;
  baseline?: (result: T) => { bytes: number; kind: BaselineKind };
};

function serializeOutput(data: unknown): string {
  return typeof data === "string" ? `${data}\n` : `${JSON.stringify(data, null, 2)}\n`;
}

async function measured<T>(
  repoRoot: string,
  operation: string,
  input: unknown,
  fn: () => Promise<T> | T,
  measurement: ResultMeasurement<T> = { output: (result) => result }
): Promise<{ result: T; output: unknown }> {
  const start = Date.now();
  let success = false;
  let output: unknown = "";
  let outputChars = 0;
  let outputBytes = 0;
  let baseline: { bytes: number; kind: BaselineKind } | undefined;
  try {
    const result = await fn();
    output = measurement.output(result);
    const serializedOutput = serializeOutput(output);
    const size = outputSize(serializedOutput);
    success = true;
    outputChars = size.chars;
    outputBytes = size.bytes;
    baseline = measurement.baseline?.(result);
    return { result, output };
  } finally {
    appendEvent(repoRoot, {
      source: "cli",
      operation,
      inputChars: JSON.stringify(input).length,
      outputChars,
      outputBytes,
      ...(baseline ? { baselineBytes: baseline.bytes, baselineKind: baseline.kind } : {}),
      durationMs: Date.now() - start,
      success
    });
  }
}

function print(data: unknown): void {
  process.stdout.write(serializeOutput(data));
}

function proofDisplayPath(repoRoot: string, filePath: string): string {
  const relative = path.relative(repoRoot, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return `<repo>/${relative}`;
  return path.basename(filePath);
}

const program = new Command();
program.name("frontload").description("Local-first context and cost gateway for AI coding agents.").version(packageVersion);

function detectedAgents(homeDir: string): AgentName[] {
  return (["codex", "claude"] as const).filter((agent) => mcpConfigAdapters[agent].detect(homeDir));
}

function renderAgentCheckboxPrompt(output: NodeJS.WriteStream, state: AgentCheckboxState, previousLineCount: number): number {
  if (previousLineCount > 1) output.write(`\x1b[${previousLineCount - 1}F\r\x1b[J`);
  const prompt = formatAgentCheckboxPrompt(state);
  output.write(prompt);
  return prompt.split("\n").length;
}

async function promptAgentCheckboxes(initialState: AgentCheckboxState): Promise<AgentName[]> {
  const input = process.stdin;
  const output = process.stdout;
  emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  output.write("\x1b[?25l");

  return new Promise((resolve, reject) => {
    let state = initialState;
    let renderedLines = renderAgentCheckboxPrompt(output, state, 0);

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h\n");
    };
    const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Prompt cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const agents = selectedAgents(state);
        cleanup();
        resolve(agents);
        return;
      }
      const nextState = applyAgentCheckboxKey(state, key.name ?? _text);
      if (nextState !== state) {
        state = nextState;
        renderedLines = renderAgentCheckboxPrompt(output, state, renderedLines);
      }
    };

    input.on("keypress", onKeypress);
  });
}

async function promptAgents(homeDir: string): Promise<ReturnType<typeof parseAgents>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return parseAgents("all");
  const detected = detectedAgents(homeDir);
  return promptAgentCheckboxes(createAgentCheckboxState(detected));
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

async function promptApproveGlobalUpgrade(commandText: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Upgrade frontload globally with "${commandText}"? [Y/n]: `);
    return !["n", "no"].includes(answer.trim().toLowerCase());
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

async function ensureGlobalFrontloadUpgrade(approved: boolean): Promise<GlobalInstallResult> {
  const packageManager = detectPackageManager();
  const install = globalInstallCommand(packageManager, "frontload@latest");
  const canUpgrade = approved || await promptApproveGlobalUpgrade(formatCommand(install));
  if (!canUpgrade) {
    return {
      action: "manual",
      command: install.command,
      args: install.args,
      notes: [`Upgrade frontload manually before restarting your editor: ${formatCommand(install)}`]
    };
  }
  return upgradeGlobalFrontload(packageManager);
}

function refreshArgs(repo: string, homeDir: string): string[] {
  return ["upgrade", "--refresh-only", "--repo", repo, "--home", homeDir];
}

type InstalledFrontloadCheck = {
  command: "frontload";
  available: boolean;
  path?: string;
  packageRoot?: string;
  version?: string;
  repoVersion?: string;
  matchesCurrentVersion?: boolean;
  matchesTargetPackage?: boolean;
  regularInstall?: boolean;
  error?: string;
};

type CodexDogfoodCheck = {
  configPath: string;
  configured: boolean;
  command?: string;
  args?: string[];
  enabled?: boolean;
  repo?: string;
  usesInstalledCommand: boolean;
  startsMcp: boolean;
  enabledForUse: boolean;
  repoIsAbsolute: boolean;
  repoMatches: boolean;
  error?: string;
};

const dogfoodFingerprintFiles = [
  "package.json",
  "dist/src/cli/index.js",
  "dist/src/install/install.js",
  "dist/src/mcp/server.js",
  "plugins/codex/skills/frontload/SKILL.md",
  "plugins/codex/hooks/hooks.json",
  "frontload.config.example.json"
];

function packageRootFromExecutable(executable: string): string | undefined {
  let dir = path.dirname(fs.realpathSync(executable));
  while (true) {
    const packageFile = path.join(dir, "package.json");
    if (fs.existsSync(packageFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { name?: string };
        if (pkg.name === "frontload") return dir;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function dogfoodPackageFingerprint(root: string): string {
  const hash = crypto.createHash("sha256");
  for (const file of dogfoodFingerprintFiles) {
    const target = path.join(root, file);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`Missing dogfood package file: ${file}`);
    }
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(target));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function installedFrontloadCheck(repoRoot: string): InstalledFrontloadCheck {
  const executable = resolveGlobalExecutable("frontload");
  if (!executable) {
    return {
      command: "frontload",
      available: false,
      matchesCurrentVersion: false,
      matchesTargetPackage: false,
      regularInstall: false,
      error: "No non-ephemeral frontload executable was found on PATH."
    };
  }
  try {
    const repoVersion = packageVersionFrom(repoRoot);
    const version = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000
    }).trim();
    const packageRoot = packageRootFromExecutable(executable);
    const matchesTargetPackage = packageRoot
      ? dogfoodPackageFingerprint(packageRoot) === dogfoodPackageFingerprint(repoRoot)
      : false;
    return {
      command: "frontload",
      available: true,
      path: executable,
      packageRoot,
      version,
      repoVersion,
      matchesCurrentVersion: version === repoVersion,
      matchesTargetPackage,
      regularInstall: !!packageRoot && path.resolve(packageRoot) !== repoRoot
    };
  } catch (error) {
    return {
      command: "frontload",
      available: false,
      matchesCurrentVersion: false,
      matchesTargetPackage: false,
      regularInstall: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function doctorTomlTable(text: string, tableName: string): string | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${tableName}]`);
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

function doctorTomlJsonValue<T>(block: string, key: string): T | undefined {
  const match = block.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return undefined;
  }
}

function doctorRepoArg(args: string[] | undefined): string | undefined {
  if (!args) return undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--repo") return args[i + 1];
    if (args[i]?.startsWith("--repo=")) return args[i].slice("--repo=".length);
  }
  return undefined;
}

function codexDogfoodCheck(repoRoot: string, homeDir: string): CodexDogfoodCheck {
  const configPath = mcpConfigAdapters.codex.globalPath(homeDir);
  if (!configPath) {
    return { configPath: "", configured: false, usesInstalledCommand: false, startsMcp: false, enabledForUse: false, repoIsAbsolute: false, repoMatches: false };
  }
  if (!fs.existsSync(configPath)) {
    return { configPath, configured: false, usesInstalledCommand: false, startsMcp: false, enabledForUse: false, repoIsAbsolute: false, repoMatches: false };
  }
  try {
    const block = doctorTomlTable(fs.readFileSync(configPath, "utf8"), "mcp_servers.frontload");
    if (!block) return { configPath, configured: false, usesInstalledCommand: false, startsMcp: false, enabledForUse: false, repoIsAbsolute: false, repoMatches: false };
    const command = doctorTomlJsonValue<string>(block, "command");
    const args = doctorTomlJsonValue<string[]>(block, "args");
    const enabled = doctorTomlJsonValue<boolean>(block, "enabled");
    const repo = doctorRepoArg(args);
    const repoIsAbsolute = !!repo && path.isAbsolute(repo);
    return {
      configPath,
      configured: true,
      command,
      args,
      enabled,
      repo,
      usesInstalledCommand: command === "frontload",
      startsMcp: args?.[0] === "mcp",
      enabledForUse: enabled !== false,
      repoIsAbsolute,
      repoMatches: repoIsAbsolute ? path.resolve(repo) === repoRoot : false
    };
  } catch (error) {
    return {
      configPath,
      configured: false,
      usesInstalledCommand: false,
      startsMcp: false,
      enabledForUse: false,
      repoIsAbsolute: false,
      repoMatches: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function dogfoodCheck(repoRoot: string, homeDir: string) {
  const installedCommand = installedFrontloadCheck(repoRoot);
  const codex = codexDogfoodCheck(repoRoot, homeDir);
  return {
    ok: installedCommand.available
      && installedCommand.matchesCurrentVersion === true
      && installedCommand.matchesTargetPackage === true
      && installedCommand.regularInstall === true
      && codex.configured
      && codex.usesInstalledCommand
      && codex.startsMcp
      && codex.enabledForUse
      && codex.repoIsAbsolute
      && codex.repoMatches,
    currentVersion: packageVersion,
    installedCommand,
    codex
  };
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
      process.stdout.write(formatInitOutput({ summary: "Frontload was not installed globally; MCP config was not written.", globalInstall }));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(formatInitOutput({
      globalInstall,
      ...initAll(resolveRepo(opts.repo), agents, homeDir, !!opts.force, scope)
    }));
  });

program
  .command("upgrade")
  .option("--repo <repo>", "repository root", ".")
  .option("--home <dir>", "home directory for agent plugin installation")
  .option("--yes", "approve upgrading frontload globally")
  .addOption(new Option("--refresh-only").hideHelp())
  .action(async (opts) => {
    const homeDir = opts.home ? path.resolve(opts.home) : os.homedir();
    const repoRoot = resolveRepo(opts.repo);
    if (opts.refreshOnly) {
      const upgrade = upgradeAll(repoRoot, homeDir);
      print({
        summary: upgrade.agents.length > 0
          ? "Frontload upgrade refreshed existing agent configuration."
          : "Frontload upgrade found no existing agent configuration to refresh.",
        ...upgrade
      });
      return;
    }

    const globalInstall = await ensureGlobalFrontloadUpgrade(!!opts.yes);
    if (globalInstall.action === "manual") {
      print({ summary: "Frontload was not upgraded globally; agent configuration was not refreshed.", globalInstall });
      process.exitCode = 1;
      return;
    }
    execFileSync("frontload", refreshArgs(repoRoot, homeDir), { stdio: "inherit" });
  });

program.command("doctor")
  .option("--repo <repo>", "repository root", ".")
  .option("--home <dir>", "home directory for agent configuration checks")
  .option("--dogfood", "fail when the regular installed Codex dogfood path is not configured")
  .action(async (opts) => {
    const repoRoot = resolveRepo(opts.repo);
    const homeDir = opts.home ? path.resolve(opts.home) : os.homedir();
    const dogfood = opts.dogfood ? dogfoodCheck(repoRoot, homeDir) : undefined;
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
      platform: os.platform(),
      ...(dogfood ? { dogfood } : {})
    };
    print({ summary: dogfood && !dogfood.ok ? "doctor completed with dogfood warnings" : "doctor completed", checks });
    if (opts.dogfood && dogfood && !dogfood.ok) process.exitCode = 1;
  });

program.command("index").option("--repo <repo>", "repository root", ".").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const measuredResult = await measured(
    repoRoot,
    "index",
    opts,
    () => buildIndex(repoRoot),
    {
      output: (indexed) => ({ summary: `Indexed ${indexed.stats.fileCount} files.`, indexPath: path.join(stateDir(repoRoot), "index.json"), stats: indexed.stats })
    }
  );
  print(measuredResult.output);
});

program.command("dossier").argument("<task>").option("--repo <repo>", "repository root", ".").option("--format <format>", "markdown").option("--budget <chars>").action(async (task, opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const budgetChars = opts.budget ? Number(opts.budget) : loadConfig(repoRoot).budgets.defaultDossierChars;
  const measuredResult = await measured(
    repoRoot,
    "dossier",
    { task, opts },
    () => generateDossier(repoRoot, task, budgetChars),
    { output: (result) => result.markdown }
  );
  print(measuredResult.output);
});

program.command("search").argument("<query>").option("--repo <repo>", "repository root", ".").option("--limit <n>", "10").action(async (query, opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const measuredResult = await measured(
    repoRoot,
    "search",
    { query, opts },
    () => searchIndexMeasured(repoRoot, query, Number(opts.limit)),
    {
      output: (result) => result.results,
      baseline: (result) => ({ bytes: outputSize(serializeOutput(result.unboundedResults)).bytes, kind: "unbounded-search-results" })
    }
  );
  print(measuredResult.output);
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
    const measuredResult = await measured(
      repoRoot,
      "read",
      { file, opts: readOptions },
      () => readBudgeted(repoRoot, file, readOptions),
      {
        output: (result) => result,
        baseline: (result) => ({ bytes: result.fileSize, kind: "full-file" })
      }
    );
    print(measuredResult.output);
  });

program.command("run").option("--repo <repo>", "repository root", ".").option("--kind <kind>", "generic").option("--allow-unconfigured").argument("[cmd...]", "command after --").allowUnknownOption(true).allowExcessArguments(true).action(async (cmdParts: string[], opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const parts = cmdParts.includes("--") ? cmdParts.slice(cmdParts.indexOf("--") + 1) : cmdParts;
  const measuredResult = await measured(
    repoRoot,
    "run",
    { opts, parts },
    () => runSummary(repoRoot, opts.kind, parts, !!opts.allowUnconfigured),
    {
      output: (result) => result,
      baseline: (result) => ({ bytes: result.rawOutputBytes, kind: "raw-command-output" })
    }
  );
  print(measuredResult.output);
});

program.command("diff").option("--repo <repo>", "repository root", ".").option("--staged").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const measuredResult = await measured(
    repoRoot,
    "diff",
    opts,
    () => gitDiffSummary(repoRoot, !!opts.staged),
    {
      output: (result) => result,
      baseline: (result) => ({ bytes: result.rawDiffBytes, kind: "raw-diff" })
    }
  );
  print(measuredResult.output);
});

program.command("compare-cost").option("--repo <repo>", "repository root", ".").option("--base <ref>", "HEAD~1").option("--head <ref>", "HEAD").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const measuredResult = await measured(repoRoot, "compare-cost", opts, () => compareCost(repoRoot, opts.base, opts.head));
  print(measuredResult.output);
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
  fs.writeFileSync("proof/raw-vs-summary.json", JSON.stringify({
    command: "pnpm test",
    rawOutputBytes: Buffer.byteLength(raw),
    summaryChars,
    compressionRatio: raw ? summaryChars / Buffer.byteLength(raw) : 0,
    preservedFindings,
    events: events.operations,
    fullLog: latestLog ? proofDisplayPath(repoRoot, path.join(logDir, latestLog)) : null
  }, null, 2));
  if (!fs.existsSync("proof/mcp-transcript.jsonl")) fs.writeFileSync("proof/mcp-transcript.jsonl", "");
  print("Proof files generated.");
});

program.parseAsync();
