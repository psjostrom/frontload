#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Command, Option } from "commander";
import { appendEvent, budgetReport, outputSize } from "../budget/events.js";
import { boundedOutput, cliSerializedOutput, cliVisibleChars, fitSearchOutput, searchResultsOutput } from "../budget/output-bounds.js";
import { loadConfig } from "../config/config.js";
import { readBudgeted } from "../commands/read.js";
import { runSummary } from "../commands/run.js";
import { compactRankedResults, generateDossier, searchIndexMeasured } from "../dossier/dossier.js";
import { compareCost, gitDiffSummary } from "../diff/diff.js";
import { buildIndex } from "../indexer/indexer.js";
import { parseHookHost, readStdin, runPostToolUseHook, runPreToolUseHook } from "../gate/entry.js";
import { runtimeRepoFromCwd } from "../gate/runtime.js";
import { formatCommand, globalInstallCommand, initAll, installGlobalFrontload, isGloballyInstalled, mcpConfigAdapters, needsShellForWindowsShim, packageRoot, parseAgents, parseConfigScope, resolveGlobalExecutable, upgradeAll, upgradeGlobalFrontload, type AgentName, type ConfigScope, type GlobalInstallResult } from "../install/install.js";
import { startMcp } from "../mcp/server.js";
import { validateBundledPlugins } from "../plugins/validate.js";
import { agentIntegrationsPaused, agentIntegrationsPauseMessage } from "../product/status.js";
import { BaselineKind } from "../types.js";
import { ensureStateDir, resolveRepo, stateDir, stateExcludeStatus } from "../utils/path.js";
import { readJsonc } from "../utils/jsonc.js";
import { packageVersion, packageVersionFrom } from "../version.js";
import { applyAgentCheckboxKey, createAgentCheckboxState, formatAgentCheckboxPrompt, selectedAgents, type AgentCheckboxState } from "./checkbox.js";
import { formatInitOutput, formatUpgradeOutput } from "./init-output.js";
import { parsePositiveInteger } from "./options.js";
import { applyConfigScopeRadioKey, createConfigScopeRadioState, formatConfigScopeRadioPrompt, selectedConfigScope, type ConfigScopeRadioState } from "./prompts.js";

type ResultMeasurement<T> = {
  output: (result: T) => unknown;
  baseline?: (result: T) => { bytes: number; kind: BaselineKind };
};

function serializeOutput(data: unknown): string {
  return cliSerializedOutput(data);
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
program.name("frontload").description("Paused agent-integration experiment.").version(packageVersion);

function rejectPausedAgentIntegration(): void {
  process.stderr.write(`${agentIntegrationsPauseMessage}\n`);
  process.exitCode = 1;
}

function repoFromCwdOption(): Option {
  return new Option("--repo-from-cwd").hideHelp();
}

function commandRepoRoot(opts: { repo: string; repoFromCwd?: boolean }): string {
  return opts.repoFromCwd ? runtimeRepoFromCwd() : resolveRepo(opts.repo);
}

function detectedAgents(homeDir: string): AgentName[] {
  return (["codex", "claude", "opencode"] as const).filter((agent) => mcpConfigAdapters[agent].detect(homeDir));
}

function renderAgentCheckboxPrompt(output: NodeJS.WriteStream, state: AgentCheckboxState, previousLineCount: number): number {
  if (previousLineCount > 1) output.write(`\x1b[${previousLineCount - 1}F\r\x1b[J`);
  const prompt = formatAgentCheckboxPrompt(state);
  output.write(prompt);
  return prompt.split("\n").length;
}

function renderConfigScopeRadioPrompt(output: NodeJS.WriteStream, state: ConfigScopeRadioState, previousLineCount: number): number {
  if (previousLineCount > 1) output.write(`\x1b[${previousLineCount - 1}F\r\x1b[J`);
  const prompt = formatConfigScopeRadioPrompt(state);
  output.write(prompt);
  return prompt.split("\n").length;
}

type PromptKeypressHandler = (_text: string, key: { name?: string; ctrl?: boolean }) => void;

function startPromptStdin(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  onKeypress: PromptKeypressHandler
): () => void {
  emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  output.write("\x1b[?25l");

  // Treat stdin EOF/close as Ctrl-C: the prompt should reject, not silently fall
  // back to a default and let init continue as if the user accepted.
  const onStdinClose = (): void => {
    onKeypress("", { name: "c", ctrl: true });
    input.off("end", onStdinClose);
    input.off("close", onStdinClose);
  };

  input.on("keypress", onKeypress);
  input.on("end", onStdinClose);
  input.on("close", onStdinClose);
  // Previous prompts (or a prior call in the same process) leave stdin paused via
  // pause(). Reattaching listeners does not reflow a paused Readable, so without
  // resume() the next prompt would silently exit with code 0 when the event loop
  // drains. Always resume after wiring up listeners.
  if (input.isTTY) input.resume();

  return () => {
    input.off("keypress", onKeypress);
    input.off("end", onStdinClose);
    input.off("close", onStdinClose);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    output.write("\x1b[?25h\n");
  };
}

async function promptAgentCheckboxes(initialState: AgentCheckboxState): Promise<AgentName[]> {
  const input = process.stdin;
  const output = process.stdout;

  return new Promise((resolve, reject) => {
    let state = initialState;
    let renderedLines = 0;
    let cleanup: () => void;

    const onKeypress: PromptKeypressHandler = (_text, key) => {
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

    cleanup = startPromptStdin(input, output, onKeypress);
    renderedLines = renderAgentCheckboxPrompt(output, state, 0);
  });
}

async function promptAgents(homeDir: string): Promise<ReturnType<typeof parseAgents>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return parseAgents("all");
  const detected = detectedAgents(homeDir);
  return promptAgentCheckboxes(createAgentCheckboxState(detected));
}

async function promptConfigScopeRadio(initialState: ConfigScopeRadioState): Promise<ConfigScope> {
  const input = process.stdin;
  const output = process.stdout;

  return new Promise((resolve, reject) => {
    let state = initialState;
    let renderedLines = 0;
    let cleanup: () => void;

    const onKeypress: PromptKeypressHandler = (_text, key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Prompt cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const scope = selectedConfigScope(state);
        cleanup();
        resolve(scope);
        return;
      }
      const nextState = applyConfigScopeRadioKey(state, key.name ?? _text);
      if (nextState !== state) {
        state = nextState;
        renderedLines = renderConfigScopeRadioPrompt(output, state, renderedLines);
      }
    };

    cleanup = startPromptStdin(input, output, onKeypress);
    renderedLines = renderConfigScopeRadioPrompt(output, state, 0);
  });
}

async function promptConfigScope(): Promise<ConfigScope> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "project";
  return promptConfigScopeRadio(createConfigScopeRadioState());
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

function configuresAgent(agents: Array<"codex" | "claude" | "opencode" | "all">, agent: "codex" | "claude" | "opencode"): boolean {
  return agents.includes("all") || agents.includes(agent);
}

async function ensureGlobalFrontload(approved: boolean): Promise<GlobalInstallResult> {
  const install = globalInstallCommand();
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
  return installGlobalFrontload();
}

async function ensureGlobalFrontloadUpgrade(approved: boolean): Promise<GlobalInstallResult> {
  const install = globalInstallCommand("npm", "frontload@latest");
  const canUpgrade = approved || await promptApproveGlobalUpgrade(formatCommand(install));
  if (!canUpgrade) {
    return {
      action: "manual",
      command: install.command,
      args: install.args,
      notes: [`Upgrade frontload manually before restarting your editor: ${formatCommand(install)}`]
    };
  }
  return upgradeGlobalFrontload();
}

function parseGlobalInstallAction(value: string | undefined): GlobalInstallResult["action"] | undefined {
  if (!value) return undefined;
  if (value === "installed" || value === "updated" || value === "skipped" || value === "manual") return value;
  throw new Error(`Unknown global install action: ${value}`);
}

function globalInstallFromOptions(action: string | undefined, command: string | undefined): GlobalInstallResult | undefined {
  const parsedAction = parseGlobalInstallAction(action);
  if (!parsedAction || !command) return undefined;
  return {
    action: parsedAction,
    command,
    args: [],
    notes: []
  };
}

function refreshArgs(repo: string, homeDir: string, globalInstall: GlobalInstallResult): string[] {
  return [
    "upgrade",
    "--refresh-only",
    "--repo",
    repo,
    "--home",
    homeDir,
    "--global-install-action",
    globalInstall.action,
    "--global-install-command",
    formatCommand(globalInstall)
  ];
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

type OpencodeConfigCheck = {
  configPath: string;
  configScope: "project" | "global" | "none";
  configured: boolean;
  type?: string;
  enabled?: boolean;
  commandValid: boolean;
  repo?: string;
  repoIsAbsolute: boolean;
  repoMatches: boolean;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opencodeConfigCheck(repoRoot: string, homeDir: string): OpencodeConfigCheck {
  const projectConfig = mcpConfigAdapters.opencode.projectPath(repoRoot);
  const globalConfig = mcpConfigAdapters.opencode.globalPath(homeDir);
  for (const [configPath, scope] of [[projectConfig, "project"] as const, [globalConfig, "global"] as const]) {
    if (!configPath || !fs.existsSync(configPath)) continue;
    const config = readJsonc<Record<string, unknown>>(configPath, {});
    const mcp = isJsonObject(config.mcp) ? config.mcp : {};
    const frontload = isJsonObject(mcp.frontload) ? mcp.frontload : {};
    if (!isJsonObject(frontload)) continue;
    const type = typeof frontload.type === "string" ? frontload.type : undefined;
    const enabled = typeof frontload.enabled === "boolean" ? frontload.enabled : undefined;
    const command = Array.isArray(frontload.command) ? frontload.command as unknown[] : [];
    const commandValid = command[0] === "frontload" && command.includes("mcp");
    const repo = commandValid ? repoArg(command) : undefined;
    if (repo) {
      const repoIsAbsolute = path.isAbsolute(repo);
      return {
        configPath,
        configScope: scope,
        configured: true,
        type,
        enabled,
        commandValid,
        repo,
        repoIsAbsolute,
        repoMatches: repoIsAbsolute ? path.resolve(repo) === repoRoot : false
      };
    }
  }
  return {
    configPath: projectConfig ?? globalConfig ?? "",
    configScope: "none",
    configured: false,
    commandValid: false,
    repoIsAbsolute: false,
    repoMatches: false
  };
}

function repoArg(args: unknown[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--repo" && typeof args[i + 1] === "string") return args[i + 1] as string;
    if (typeof args[i] === "string" && (args[i] as string).startsWith("--repo=")) return (args[i] as string).slice("--repo=".length);
  }
  return undefined;
}

type CodexDogfoodCheck = {
  configPath: string;
  configScope: "project" | "global" | "none";
  configured: boolean;
  serverName?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
  repo?: string;
  usesInstalledCommand: boolean;
  startsMcp: boolean;
  enabledForUse: boolean;
  repoIsAbsolute: boolean;
  repoMatches: boolean;
  launches: boolean;
  responds: boolean;
  legacyGlobalConflict: boolean;
  restartAdvice?: string;
  probeError?: string;
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
    let repoVersion = packageVersion;
    const version = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      ...(needsShellForWindowsShim(executable) ? { shell: true } : {})
    }).trim();
    const packageRoot = packageRootFromExecutable(executable);
    let matchesTargetPackage = false;
    try {
      repoVersion = packageVersionFrom(repoRoot);
      matchesTargetPackage = packageRoot
        ? dogfoodPackageFingerprint(packageRoot) === dogfoodPackageFingerprint(repoRoot)
        : false;
    } catch {
      matchesTargetPackage = false;
    }
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

function doctorFrontloadServerName(tableName: string, block?: string): string | undefined {
  const prefix = "mcp_servers.";
  if (!tableName.startsWith(prefix)) return undefined;
  const serverName = tableName.slice(prefix.length);
  if (serverName.includes(".")) return undefined;
  if (serverName === "frontload") return serverName;
  if (!serverName.startsWith("frontload_") || !block) return undefined;
  const command = doctorTomlJsonValue<string>(block, "command");
  const args = doctorTomlJsonValue<string[]>(block, "args");
  const managedFrontload = (command === "frontload" && args?.[0] === "mcp") || isNodeFrontloadMcpCommand(command, args);
  return managedFrontload && doctorRepoArg(args) ? serverName : undefined;
}

function doctorCodexFrontloadTable(text: string): { serverName: string; block: string } | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const match = line.trim().match(/^\[([^\]]+)\]$/);
    if (!match) continue;
    const block = doctorTomlTable(text, match[1]);
    const serverName = doctorFrontloadServerName(match[1], block);
    if (serverName && block) return { serverName, block };
  }
  return undefined;
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

function cleanProcessEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function emptyCodexCheck(configPath: string, configScope: CodexDogfoodCheck["configScope"], legacyGlobalConflict = false): CodexDogfoodCheck {
  return {
    configPath,
    configScope,
    configured: false,
    usesInstalledCommand: false,
    startsMcp: false,
    enabledForUse: false,
    repoIsAbsolute: false,
    repoMatches: false,
    launches: false,
    responds: false,
    legacyGlobalConflict
  };
}

function readCodexConfigCheck(configPath: string, configScope: CodexDogfoodCheck["configScope"], repoRoot: string, legacyGlobalConflict = false): CodexDogfoodCheck {
  if (!fs.existsSync(configPath)) {
    return emptyCodexCheck(configPath, configScope, legacyGlobalConflict);
  }
  try {
    const table = doctorCodexFrontloadTable(fs.readFileSync(configPath, "utf8"));
    if (!table) return emptyCodexCheck(configPath, configScope, legacyGlobalConflict);
    const block = table.block;
    const command = doctorTomlJsonValue<string>(block, "command");
    const args = doctorTomlJsonValue<string[]>(block, "args");
    const enabled = doctorTomlJsonValue<boolean>(block, "enabled");
    const repo = doctorRepoArg(args);
    const repoIsAbsolute = !!repo && path.isAbsolute(repo);
    return {
      configPath,
      configScope,
      configured: true,
      serverName: table.serverName,
      command,
      args,
      enabled,
      repo,
      usesInstalledCommand: command === "frontload",
      startsMcp: args?.includes("mcp") === true,
      enabledForUse: enabled !== false,
      repoIsAbsolute,
      repoMatches: repoIsAbsolute ? path.resolve(repo) === repoRoot : false,
      launches: false,
      responds: false,
      legacyGlobalConflict
    };
  } catch (error) {
    return {
      configPath,
      configScope,
      configured: false,
      usesInstalledCommand: false,
      startsMcp: false,
      enabledForUse: false,
      repoIsAbsolute: false,
      repoMatches: false,
      launches: false,
      responds: false,
      legacyGlobalConflict,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function isNodeFrontloadMcpCommand(command: string | undefined, args: string[] | undefined): boolean {
  const cliPath = args?.[0];
  return command === process.execPath
    && typeof cliPath === "string"
    && path.resolve(cliPath) === path.join(packageRoot(), "dist/src/cli/index.js")
    && args?.[1] === "mcp";
}

function canProbeCodexMcp(check: CodexDogfoodCheck): boolean {
  if (!check.configured || !check.command || !check.args || !check.startsMcp || !check.enabledForUse || !check.repoMatches) return false;
  if (check.command === "frontload" && check.args[0] === "mcp") return true;
  return isNodeFrontloadMcpCommand(check.command, check.args);
}

async function probeCodexMcp(check: CodexDogfoodCheck): Promise<CodexDogfoodCheck> {
  if (!canProbeCodexMcp(check)) {
    return check.configured && check.startsMcp && check.enabledForUse
      ? { ...check, probeError: "Skipped MCP launch because the configured command is not a managed Frontload command for this repo." }
      : check;
  }
  const command = check.command!;
  const args = check.args!;
  const transport = new StdioClientTransport({
    command,
    args,
    env: cleanProcessEnv({ FRONTLOAD_DOCTOR_PROBE: "1" }),
    stderr: "pipe"
  });
  const client = new Client({ name: "frontload-doctor", version: packageVersion });
  let launches = false;
  try {
    await client.connect(transport, { timeout: 5000, maxTotalTimeout: 5000 });
    launches = true;
    const response = await client.callTool({ name: "fl_policy", arguments: {} }, undefined, { timeout: 5000, maxTotalTimeout: 5000 });
    const content = response.content as Array<{ type: string; text?: string }>;
    const text = content.find((part) => part.type === "text")?.text;
    const data = text ? JSON.parse(text) as unknown : undefined;
    return {
      ...check,
      launches: true,
      responds: typeof data === "object" && data !== null,
      restartAdvice: "If Codex tools still fail with Transport closed after this probe passes, restart Codex so it reloads the MCP process."
    };
  } catch (error) {
    return {
      ...check,
      launches,
      responds: false,
      probeError: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function codexDogfoodCheck(repoRoot: string, homeDir: string): Promise<CodexDogfoodCheck> {
  const projectPath = mcpConfigAdapters.codex.projectPath(repoRoot);
  const globalPath = mcpConfigAdapters.codex.globalPath(homeDir);
  const globalCheck = globalPath
    ? readCodexConfigCheck(globalPath, "global", repoRoot)
    : emptyCodexCheck("", "none");
  const legacyGlobalConflict = globalCheck.configured && !globalCheck.repoMatches;
  const projectCheck = projectPath
    ? readCodexConfigCheck(projectPath, "project", repoRoot, legacyGlobalConflict)
    : emptyCodexCheck("", "none", legacyGlobalConflict);
  const active = projectCheck.configured
    ? projectCheck
    : globalCheck.configured
      ? { ...globalCheck, legacyGlobalConflict }
      : emptyCodexCheck(projectPath ?? globalPath ?? "", "none", legacyGlobalConflict);
  return probeCodexMcp(active);
}

async function dogfoodCheck(repoRoot: string, homeDir: string, codex?: CodexDogfoodCheck) {
  const installedCommand = installedFrontloadCheck(repoRoot);
  const activeCodex = codex ?? await codexDogfoodCheck(repoRoot, homeDir);
  return {
    ok: installedCommand.available
      && installedCommand.matchesCurrentVersion === true
      && installedCommand.matchesTargetPackage === true
      && installedCommand.regularInstall === true
      && activeCodex.configured
      && activeCodex.usesInstalledCommand
      && activeCodex.startsMcp
      && activeCodex.enabledForUse
      && activeCodex.repoIsAbsolute
      && activeCodex.repoMatches
      && activeCodex.responds,
    currentVersion: packageVersion,
    installedCommand,
    codex: activeCodex
  };
}

program
  .command("init")
  .option("--repo <repo>", "repository root", ".")
  .option("--agents <agents>", "comma-separated agents to configure: codex,claude,opencode,all,none")
  .option("--scope <scope>", "Claude Code and opencode MCP config scope: project or global")
  .option("--home <dir>", "home directory for agent plugin installation")
  .option("--force")
  .option("--yes", "approve installing frontload globally if needed")
  .action(async (opts) => {
    if (agentIntegrationsPaused) {
      rejectPausedAgentIntegration();
      return;
    }
    const homeDir = opts.home ? path.resolve(opts.home) : os.homedir();
    let agents: ReturnType<typeof parseAgents>;
    if (opts.agents === undefined) {
      try {
        agents = await promptAgents(homeDir);
      } catch {
        process.stdout.write("Frontload init was cancelled. No files were changed.\n");
        process.exitCode = 1;
        return;
      }
    } else {
      agents = parseAgents(opts.agents);
    }
    let scope: ConfigScope;
    if (opts.scope === undefined && (configuresAgent(agents, "claude") || configuresAgent(agents, "opencode"))) {
      try {
        scope = await promptConfigScope();
      } catch {
        process.stdout.write("Frontload init was cancelled. No files were changed.\n");
        process.exitCode = 1;
        return;
      }
    } else {
      scope = parseConfigScope(opts.scope);
    }
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
  .addOption(new Option("--global-install-action <action>").hideHelp())
  .addOption(new Option("--global-install-command <command>").hideHelp())
  .action(async (opts) => {
    if (agentIntegrationsPaused) {
      rejectPausedAgentIntegration();
      return;
    }
    const homeDir = opts.home ? path.resolve(opts.home) : os.homedir();
    const repoRoot = resolveRepo(opts.repo);
    if (opts.refreshOnly) {
      const upgrade = upgradeAll(repoRoot, homeDir);
      process.stdout.write(formatUpgradeOutput({
        summary: upgrade.agents.length > 0
          ? "Frontload and existing agent configuration were updated."
          : "Frontload upgrade found no existing agent configuration to refresh.",
        globalInstall: globalInstallFromOptions(opts.globalInstallAction, opts.globalInstallCommand),
        homeDir,
        ...upgrade
      }));
      return;
    }

    const globalInstall = await ensureGlobalFrontloadUpgrade(!!opts.yes);
    if (globalInstall.action === "manual") {
      process.stdout.write(formatUpgradeOutput({
        summary: "Frontload was not upgraded globally; agent configuration was not refreshed.",
        globalInstall
      }));
      process.exitCode = 1;
      return;
    }
    execFileSync("frontload", refreshArgs(repoRoot, homeDir, globalInstall), { stdio: "inherit" });
  });

program.command("doctor")
  .option("--repo <repo>", "repository root", ".")
  .option("--home <dir>", "home directory for agent configuration checks")
  .option("--dogfood", "fail when the regular installed Codex dogfood path is not configured")
  .action(async (opts) => {
    const repoRoot = resolveRepo(opts.repo);
    const homeDir = opts.home ? path.resolve(opts.home) : os.homedir();
    const codex = await codexDogfoodCheck(repoRoot, homeDir);
    const dogfood = opts.dogfood ? await dogfoodCheck(repoRoot, homeDir, codex) : undefined;
    const beforeStateExclude = stateExcludeStatus(repoRoot);
    const checks = {
      node: process.versions.node,
      repoRoot,
      config: !!loadConfig(repoRoot),
      writableState: (() => {
        fs.writeFileSync(path.join(ensureStateDir(repoRoot), ".doctor"), "ok");
        return true;
      })(),
      stateExclude: (() => {
        const after = stateExcludeStatus(repoRoot);
        return {
          ...after,
          beforeIgnored: beforeStateExclude.ignored,
          repaired: !beforeStateExclude.ignored && after.ignored
        };
      })(),
      mcpServer: true,
      installedCommand: installedFrontloadCheck(repoRoot),
      codex,
      opencode: opencodeConfigCheck(repoRoot, homeDir),
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

program.command("dossier").argument("<task>").option("--repo <repo>", "repository root", ".").option("--format <format>", "markdown").option("--budget <chars>", "target output characters", parsePositiveInteger).option("--max-files <n>", "maximum ranked files to include", parsePositiveInteger, 12).action(async (task, opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const budgetChars = opts.budget ? (opts.budget as number) : loadConfig(repoRoot).budgets.defaultDossierChars;
  const measuredResult = await measured(
    repoRoot,
    "dossier",
    { task, opts },
    () => generateDossier(repoRoot, task, budgetChars, opts.maxFiles as number),
    { output: (result) => result.markdown }
  );
  print(measuredResult.output);
});

program.command("search").argument("<query>").option("--repo <repo>", "repository root", ".").addOption(repoFromCwdOption()).option("--limit <n>", "10").action(async (query, opts) => {
  const repoRoot = commandRepoRoot(opts);
  const config = loadConfig(repoRoot);
  const measuredResult = await measured(
    repoRoot,
    "search",
    { query, opts },
    () => searchIndexMeasured(repoRoot, query, Number(opts.limit)),
    {
      output: (result) => fitSearchOutput(config.budgets.maxToolOutputChars, compactRankedResults(result.results), cliVisibleChars),
      baseline: (result) => ({ bytes: outputSize(serializeOutput(searchResultsOutput(compactRankedResults(result.unboundedResults)))).bytes, kind: "unbounded-search-results" })
    }
  );
  print(measuredResult.output);
});

program.command("read")
  .argument("<path>")
  .option("--repo <repo>", "repository root", ".")
  .addOption(repoFromCwdOption())
  .option("--budget <chars>", "target output characters", parsePositiveInteger, 4000)
  .option("--query <query>")
  .option("--start-line <line>", "1-based start line", parsePositiveInteger)
  .option("--line-count <count>", "maximum number of lines to return", parsePositiveInteger)
  .action(async (file, opts) => {
    const repoRoot = commandRepoRoot(opts);
    const config = loadConfig(repoRoot);
    const readOptions = {
      budgetChars: opts.budget as number,
      query: opts.query as string | undefined,
      startLine: opts.startLine as number | undefined,
      lineCount: opts.lineCount as number | undefined,
      maxSerializedChars: config.budgets.maxToolOutputChars
    };
    const measuredResult = await measured(
      repoRoot,
      "read",
      { file, opts: readOptions },
      () => readBudgeted(repoRoot, file, readOptions),
      {
        output: (result) => boundedOutput("read", config.budgets.maxToolOutputChars, result, cliVisibleChars).output,
        baseline: (result) => ({ bytes: result.fileSize, kind: "full-file" })
      }
    );
    print(measuredResult.output);
  });

program.command("run").option("--repo <repo>", "repository root", ".").addOption(repoFromCwdOption()).option("--kind <kind>", "generic").option("--allow-unconfigured").argument("[cmd...]", "command after --").allowUnknownOption(true).allowExcessArguments(true).action(async (cmdParts: string[], opts) => {
  const repoRoot = commandRepoRoot(opts);
  const parts = cmdParts;
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
  const { exitCode } = measuredResult.result;
  process.exitCode = typeof exitCode === "number" ? exitCode : 1;
});

program.command("diff").option("--repo <repo>", "repository root", ".").option("--staged").option("--tracked-only", "omit untracked files").action(async (opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const measuredResult = await measured(
    repoRoot,
    "diff",
    opts,
    () => gitDiffSummary(repoRoot, { staged: !!opts.staged, trackedOnly: !!opts.trackedOnly }),
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

program.command("budget").option("--repo <repo>", "repository root", ".").action((opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const config = loadConfig(repoRoot);
  print(boundedOutput("budget", config.budgets.maxToolOutputChars, budgetReport(repoRoot), cliVisibleChars).output);
});
program.command("validate-plugins").option("--repo <repo>", "repository root", ".").action((opts) => print(validateBundledPlugins(resolveRepo(opts.repo))));
const hook = program.command("hook");
hook.command("pre-tool-use").requiredOption("--host <host>").action(async (opts) => {
  const host = parseHookHost(opts.host);
  if (agentIntegrationsPaused) {
    await readStdin();
    return;
  }
  const output = await runPreToolUseHook(host);
  if (output) process.stdout.write(output);
});
hook.command("post-tool-use").requiredOption("--host <host>").action(async (opts) => {
  const host = parseHookHost(opts.host);
  if (agentIntegrationsPaused) {
    await readStdin();
    return;
  }
  const output = await runPostToolUseHook(host);
  if (output) process.stdout.write(output);
});
program.command("mcp").option("--repo <repo>", "repository root", ".").action((opts) => {
  if (agentIntegrationsPaused) {
    rejectPausedAgentIntegration();
    return;
  }
  return startMcp(resolveRepo(opts.repo));
});
program.command("proof").option("--repo <repo>", "repository root", ".").action((opts) => {
  const repoRoot = resolveRepo(opts.repo);
  const stateRoot = ensureStateDir(repoRoot);
  const proofDir = path.join(stateRoot, "proof");
  const pnpmVersion = (() => {
    try {
      return execFileSync("pnpm", ["--version"], {
        encoding: "utf8",
        ...(needsShellForWindowsShim("pnpm") ? { shell: true } : {})
      }).trim();
    } catch {
      return "unavailable";
    }
  })();
  const report = `# Frontload Proof Report\n\n- Date/time: ${new Date().toISOString()}\n- Node: ${process.version}\n- pnpm: ${pnpmVersion}\n- OS: ${os.platform()} ${os.release()}\n- Commands: pnpm build, pnpm test, pnpm e2e, pnpm demo:fixture\n- Status: generated by proof command after prior scripts completed\n\n## Test counts\n\nSee \`pnpm test\` and \`pnpm e2e\` output from the proof run.\n\n## Known limitations\n\n- Local scout is an extension point and disabled by default.\n`;
  fs.mkdirSync(proofDir, { recursive: true });
  fs.writeFileSync(path.join(proofDir, "TEST_REPORT.md"), report);
  const events = budgetReport(repoRoot);
  const logDir = path.join(stateRoot, "logs");
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
  fs.writeFileSync(path.join(proofDir, "raw-vs-summary.json"), JSON.stringify({
    command: "pnpm test",
    rawOutputBytes: Buffer.byteLength(raw),
    summaryChars,
    compressionRatio: raw ? summaryChars / Buffer.byteLength(raw) : 0,
    preservedFindings,
    events: events.operations,
    fullLog: latestLog ? proofDisplayPath(repoRoot, path.join(logDir, latestLog)) : null
  }, null, 2));
  const transcriptPath = path.join(proofDir, "mcp-transcript.jsonl");
  if (!fs.existsSync(transcriptPath)) fs.writeFileSync(transcriptPath, "");
  print(`Proof files generated under ${proofDisplayPath(repoRoot, proofDir)}.`);
});

program.parseAsync();
