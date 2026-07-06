import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hookDefinitions, type HookDefinition } from "../hooks/definitions.js";

export type AgentName = "codex" | "claude";
export type ConfigScope = "project" | "global";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type McpEntry = {
  command: string;
  args: string[];
};

export type WriteResult = {
  path: string;
  action: "created" | "updated" | "skipped";
};

export type InstallResult = {
  agent: AgentName;
  writes: WriteResult[];
  notes: string[];
};

export type InitResult = {
  repoRoot: string;
  project: WriteResult[];
  agents: InstallResult[];
};

export type GlobalInstallCommand = {
  packageManager: PackageManager;
  command: string;
  args: string[];
};

export type GlobalInstallResult = {
  action: "installed" | "updated" | "skipped" | "manual";
  command: string;
  args: string[];
  notes: string[];
  error?: string;
};

export type McpConfigAdapter = {
  name: string;
  detect(homeDir: string): boolean;
  projectPath(repoRoot: string): string | null;
  globalPath(homeDir: string): string | null;
  write(configPath: string, entry: McpEntry, force: boolean): WriteResult;
  remove(configPath: string): boolean;
  hasFrontloadEntry(configPath: string): boolean;
};

type InstallRunner = (command: string, args: string[], options: { stdio: "inherit" }) => unknown;
type JsonObject = Record<string, unknown>;

export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (parsed.name === "frontload") return dir;
      } catch {
        // Keep walking upward.
      }
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function copyDir(source: string, target: string, force: boolean, writes: WriteResult[]): void {
  const existed = fs.existsSync(target);
  if (existed) {
    if (!force) {
      writes.push({ path: target, action: "skipped" });
      return;
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  writes.push({ path: target, action: existed ? "updated" : "created" });
}

function copyFile(source: string, target: string, force: boolean): WriteResult {
  const existed = fs.existsSync(target);
  if (existed && !force) return { path: target, action: "skipped" };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return { path: target, action: existed ? "updated" : "created" };
}

function ensureDir(target: string): WriteResult {
  if (fs.existsSync(target)) return { path: target, action: "skipped" };
  fs.mkdirSync(target, { recursive: true });
  return { path: target, action: "created" };
}

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpJsonServer(entry: McpEntry): Record<string, unknown> {
  return { type: "stdio", command: entry.command, args: entry.args };
}

function upsertJsonMcpServer(file: string, entry: McpEntry, force: boolean): WriteResult {
  const existed = fs.existsSync(file);
  const config = readJson<Record<string, unknown>>(file, {});
  const servers = typeof config.mcpServers === "object" && config.mcpServers !== null && !Array.isArray(config.mcpServers)
    ? config.mcpServers as Record<string, unknown>
    : {};
  const next = mcpJsonServer(entry);
  if (!force && sameJson(servers.frontload, next)) return { path: file, action: "skipped" };
  servers.frontload = next;
  config.mcpServers = servers;
  writeJson(file, config);
  return { path: file, action: existed ? "updated" : "created" };
}

function removeJsonMcpServer(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const config = readJson<Record<string, unknown>>(file, {});
  if (typeof config.mcpServers !== "object" || config.mcpServers === null || Array.isArray(config.mcpServers)) return false;
  const servers = config.mcpServers as Record<string, unknown>;
  if (!("frontload" in servers)) return false;
  delete servers.frontload;
  writeJson(file, config);
  return true;
}

function hasJsonMcpServer(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const config = readJson<Record<string, unknown>>(file, {});
  return typeof config.mcpServers === "object" && config.mcpServers !== null && !Array.isArray(config.mcpServers) && "frontload" in config.mcpServers;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function codexMcpTomlBlock(entry: McpEntry): string {
  return [
    "[mcp_servers.frontload]",
    `command = ${tomlString(entry.command)}`,
    `args = ${tomlArray(entry.args)}`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 120",
    "enabled = true",
    "required = false",
    "enabled_tools = [",
    "  \"fl_policy\",",
    "  \"fl_repo_index\",",
    "  \"fl_repo_dossier\",",
    "  \"fl_search\",",
    "  \"fl_read_budgeted\",",
    "  \"fl_run_summary\",",
    "  \"fl_git_diff_summary\",",
    "  \"fl_budget_report\",",
    "  \"fl_local_scout\"",
    "]",
    "default_tools_approval_mode = \"prompt\""
  ].join("\n");
}

function tomlTableName(line: string): string | null {
  const match = line.trim().match(/^\[([^\]]+)\]$/);
  return match ? match[1] : null;
}

function isDifferentTomlTable(line: string, tableName: string): boolean {
  const name = tomlTableName(line);
  return !!name && name !== tableName && !name.startsWith(`${tableName}.`);
}

function upsertTomlTable(text: string, tableName: string, block: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => tomlTableName(line) === tableName);
  if (start === -1) {
    const prefix = normalized.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${block}\n`;
  }

  let end = start + 1;
  while (end < lines.length && !isDifferentTomlTable(lines[end], tableName)) end += 1;
  const nextLines = [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(end)];
  return `${nextLines.join("\n").trimEnd()}\n`;
}

function removeTomlTable(text: string, tableName: string): { text: string; removed: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => tomlTableName(line) === tableName);
  if (start === -1) return { text, removed: false };

  let end = start + 1;
  while (end < lines.length && !isDifferentTomlTable(lines[end], tableName)) end += 1;
  const next = `${[...lines.slice(0, start), ...lines.slice(end)].join("\n").trimEnd()}\n`;
  return { text: next, removed: true };
}

function upsertCodexMcpServer(file: string, entry: McpEntry, force: boolean): WriteResult {
  const existed = fs.existsSync(file);
  const current = existed ? fs.readFileSync(file, "utf8") : "";
  const next = upsertTomlTable(current, "mcp_servers.frontload", codexMcpTomlBlock(entry));
  if (!force && current === next) return { path: file, action: "skipped" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return { path: file, action: existed ? "updated" : "created" };
}

function removeCodexMcpServer(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, "utf8");
  const result = removeTomlTable(current, "mcp_servers.frontload");
  if (!result.removed) return false;
  fs.writeFileSync(file, result.text);
  return true;
}

function hasCodexMcpServer(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, "utf8").split(/\r?\n/).some((line) => line.trim() === "[mcp_servers.frontload]");
}

function claudeSettingsPath(repoRoot: string, homeDir: string, scope: ConfigScope): string {
  return scope === "global" ? path.join(homeDir, ".claude/settings.json") : path.join(repoRoot, ".claude/settings.json");
}

function isFrontloadHook(hook: unknown): boolean {
  if (!isJsonObject(hook)) return false;
  if (typeof hook.command !== "string") return false;
  if (/\bfrontload\s+hook\s+(?:pre-tool-use|post-tool-use)(?:\s|$)/.test(hook.command)) return true;
  return hook.command === "frontload" &&
    Array.isArray(hook.args) &&
    hook.args[0] === "hook" &&
    (hook.args[1] === "pre-tool-use" || hook.args[1] === "post-tool-use");
}

function withoutFrontloadHook(group: unknown): JsonObject | null {
  if (!isJsonObject(group)) return null;
  if (!Array.isArray(group.hooks)) return group;
  const hooks = group.hooks.filter((hook) => !isFrontloadHook(hook));
  if (hooks.length === 0) return null;
  return { ...group, hooks };
}

function upsertHookGroups(file: string, definitions: HookDefinition[], force: boolean): WriteResult {
  const existed = fs.existsSync(file);
  const current = readJson<JsonObject>(file, {});
  const hooks = isJsonObject(current.hooks) ? current.hooks : {};
  const nextHooks: JsonObject = { ...hooks };
  for (const definition of definitions) {
    const currentGroups: unknown[] = Array.isArray(hooks[definition.event]) ? hooks[definition.event] as unknown[] : [];
    nextHooks[definition.event] = currentGroups
      .map(withoutFrontloadHook)
      .filter((group): group is JsonObject => group !== null)
      .concat([{ matcher: definition.matcher, hooks: [definition.hook] }]);
  }
  const next = {
    ...current,
    hooks: nextHooks
  };

  if (!force && sameJson(current, next)) return { path: file, action: "skipped" };
  writeJson(file, next);
  return { path: file, action: existed ? "updated" : "created" };
}

export function buildMcpEntry(repo = "."): McpEntry {
  return { command: "frontload", args: ["mcp", "--repo", repo] };
}

export const mcpConfigAdapters: Record<AgentName, McpConfigAdapter> = {
  codex: {
    name: "Codex",
    detect: (homeDir) => fs.existsSync(path.join(homeDir, ".codex")),
    projectPath: (repoRoot) => path.join(repoRoot, ".codex/config.toml"),
    globalPath: (homeDir) => path.join(homeDir, ".codex/config.toml"),
    write: upsertCodexMcpServer,
    remove: removeCodexMcpServer,
    hasFrontloadEntry: hasCodexMcpServer
  },
  claude: {
    name: "Claude Code",
    detect: (homeDir) => fs.existsSync(path.join(homeDir, ".claude")) || fs.existsSync(path.join(homeDir, ".claude.json")),
    projectPath: (repoRoot) => path.join(repoRoot, ".mcp.json"),
    globalPath: (homeDir) => path.join(homeDir, ".claude.json"),
    write: upsertJsonMcpServer,
    remove: removeJsonMcpServer,
    hasFrontloadEntry: hasJsonMcpServer
  }
};

function copyFrontloadSkill(agent: AgentName, homeDir: string, force: boolean, writes: WriteResult[]): void {
  const root = packageRoot();
  const target = agent === "codex"
    ? path.join(homeDir, ".codex/skills/frontload")
    : path.join(homeDir, ".claude/skills/frontload");
  copyDir(path.join(root, `plugins/${agent}/skills/frontload`), target, force, writes);
}

function executableNames(command: string): string[] {
  if (process.platform !== "win32") return [command];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  return extensions.map((ext) => `${command}${ext.toLowerCase()}`).concat(extensions.map((ext) => `${command}${ext.toUpperCase()}`), command);
}

function findExecutablesOnPath(command: string, envPath = process.env.PATH ?? ""): string[] {
  const executables: string[] = [];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames(command)) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        executables.push(candidate);
      } catch {
        // Keep looking through PATH.
      }
    }
  }
  return executables;
}

function isEphemeralPackagePath(value: string): boolean {
  const normalized = value.replaceAll(path.sep, "/");
  return normalized.includes("/_npx/") || normalized.includes("/dlx-") || normalized.includes("/.pnpm/dlx/") || normalized.includes("/node_modules/.bin/");
}

export function resolveGlobalExecutable(bin = "frontload", envPath = process.env.PATH ?? ""): string | undefined {
  return findExecutablesOnPath(bin, envPath).find((executable) => !isEphemeralPackagePath(executable));
}

export function isGloballyInstalled(bin = "frontload", envPath = process.env.PATH ?? "", currentPackageRoot = packageRoot()): boolean {
  void currentPackageRoot;
  return resolveGlobalExecutable(bin, envPath) !== undefined;
}

export function detectPackageManager(userAgent = process.env.npm_config_user_agent ?? ""): PackageManager {
  const name = userAgent.split(/[ /]/)[0];
  if (name === "pnpm" || name === "yarn" || name === "bun") return name;
  return "npm";
}

export function globalInstallCommand(packageManager: PackageManager = "npm", pkg = "frontload"): GlobalInstallCommand {
  switch (packageManager) {
    case "pnpm":
      return { packageManager, command: "pnpm", args: ["add", "-g", pkg] };
    case "yarn":
      return { packageManager, command: "yarn", args: ["global", "add", pkg] };
    case "bun":
      return { packageManager, command: "bun", args: ["add", "-g", pkg] };
    case "npm":
    default:
      return { packageManager: "npm", command: "npm", args: ["install", "-g", pkg] };
  }
}

export function formatCommand(command: Pick<GlobalInstallCommand, "command" | "args">): string {
  return [command.command, ...command.args].join(" ");
}

export function installGlobalFrontload(packageManager: PackageManager = "npm", runner: InstallRunner = execFileSync): GlobalInstallResult {
  const install = globalInstallCommand(packageManager);
  if (isGloballyInstalled()) {
    return {
      action: "skipped",
      command: install.command,
      args: install.args,
      notes: ["A frontload binary is already available on PATH."]
    };
  }
  try {
    runner(install.command, install.args, { stdio: "inherit" });
    if (!isGloballyInstalled()) {
      return {
        action: "manual",
        command: install.command,
        args: install.args,
        notes: [
          `The global install command completed, but frontload is still not resolvable on PATH. Install or expose it before restarting your editor: ${formatCommand(install)}`
        ],
        error: "frontload binary was not found on PATH after install"
      };
    }
    return {
      action: "installed",
      command: install.command,
      args: install.args,
      notes: ["Installed frontload globally so editor MCP configs can launch it by name."]
    };
  } catch (error) {
    return {
      action: "manual",
      command: install.command,
      args: install.args,
      notes: [`Install frontload globally before restarting your editor: ${formatCommand(install)}`],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function upgradeGlobalFrontload(packageManager: PackageManager = "npm", runner: InstallRunner = execFileSync): GlobalInstallResult {
  const wasInstalled = isGloballyInstalled();
  const install = globalInstallCommand(packageManager, "frontload@latest");
  try {
    runner(install.command, install.args, { stdio: "inherit" });
    if (!isGloballyInstalled()) {
      return {
        action: "manual",
        command: install.command,
        args: install.args,
        notes: [
          `The upgrade command completed, but frontload is still not resolvable on PATH. Install or expose it before restarting your editor: ${formatCommand(install)}`
        ],
        error: "frontload binary was not found on PATH after upgrade"
      };
    }
    return {
      action: wasInstalled ? "updated" : "installed",
      command: install.command,
      args: install.args,
      notes: [wasInstalled ? "Updated frontload globally." : "Installed frontload globally."]
    };
  } catch (error) {
    return {
      action: "manual",
      command: install.command,
      args: install.args,
      notes: [`Upgrade frontload manually before restarting your editor: ${formatCommand(install)}`],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function initProject(repoRoot: string, force = false): WriteResult[] {
  const root = packageRoot();
  const absRepo = path.resolve(repoRoot);
  const writes: WriteResult[] = [
    copyFile(path.join(root, "frontload.config.example.json"), path.join(absRepo, "frontload.config.json"), force),
    ensureDir(path.join(absRepo, ".frontload"))
  ];
  return writes;
}

function configureCodex(repoRoot: string, homeDir = os.homedir(), force = false): InstallResult {
  const configPath = mcpConfigAdapters.codex.projectPath(repoRoot);
  if (!configPath) throw new Error("Codex does not support project-local MCP config from init.");
  return configureCodexAt(configPath, homeDir, buildMcpEntry(repoRoot), hookDefinitions.codex, force, "project");
}

function codexNotes(configScope: "project" | "legacy-global"): string[] {
  const configNote = configScope === "project"
    ? "Codex MCP config was written to project .codex/config.toml; hooks and the Frontload skill were written to your global Codex config."
    : "Codex MCP config was refreshed in legacy global ~/.codex/config.toml; hooks and the Frontload skill were written to your global Codex config.";
  const restartNote = configScope === "project"
    ? "Restart Codex after init completes; /mcp should show the frontload server for this repo."
    : "Restart Codex after upgrade completes; /mcp should show the frontload server.";
  return [
    configNote,
    restartNote,
    "Open /hooks once to review and approve the Frontload command hooks."
  ];
}

function configureCodexAt(configPath: string, homeDir: string, entry: McpEntry, definitions: HookDefinition[], force: boolean, configScope: "project" | "legacy-global"): InstallResult {
  const writes = [
    mcpConfigAdapters.codex.write(configPath, entry, force)
  ];
  if (definitions.length > 0) {
    writes.push(upsertHookGroups(path.join(homeDir, ".codex/hooks.json"), definitions, force));
  }
  copyFrontloadSkill("codex", homeDir, force, writes);
  return {
    agent: "codex",
    writes,
    notes: codexNotes(configScope)
  };
}

function configureClaude(repoRoot: string, homeDir = os.homedir(), force = false, scope: ConfigScope = "project"): InstallResult {
  const configPath = scope === "global" ? mcpConfigAdapters.claude.globalPath(homeDir) : mcpConfigAdapters.claude.projectPath(repoRoot);
  if (!configPath) throw new Error(`Claude Code does not support ${scope} MCP config from init.`);
  return configureClaudeAt(repoRoot, homeDir, scope, configPath, buildMcpEntry(repoRoot), hookDefinitions.claude, force);
}

function configureClaudeAt(repoRoot: string, homeDir: string, scope: ConfigScope, configPath: string, entry: McpEntry, definitions: HookDefinition[], force: boolean): InstallResult {
  const writes = [
    mcpConfigAdapters.claude.write(configPath, entry, force)
  ];
  if (definitions.length > 0) {
    writes.push(upsertHookGroups(claudeSettingsPath(repoRoot, homeDir, scope), definitions, force));
  }
  copyFrontloadSkill("claude", homeDir, force, writes);
  return {
    agent: "claude",
    writes,
    notes: ["Restart Claude Code after init completes; /mcp should show the frontload server and the Frontload gate hook will enforce configured savings."]
  };
}

function configureAgent(agent: AgentName | "all", repoRoot: string, homeDir = os.homedir(), force = false, scope: ConfigScope = "project"): InstallResult[] {
  if (agent === "all") return [configureCodex(repoRoot, homeDir, force), configureClaude(repoRoot, homeDir, force, scope)];
  if (agent === "codex") return [configureCodex(repoRoot, homeDir, force)];
  if (agent === "claude") return [configureClaude(repoRoot, homeDir, force, scope)];
  throw new Error(`Unknown agent: ${agent}`);
}

export function parseAgents(value: string | undefined): Array<AgentName | "all"> {
  if (!value || value === "none") return [];
  const values = value.split(",").map((part) => part.trim()).filter(Boolean);
  for (const agent of values) {
    if (!["codex", "claude", "all"].includes(agent)) throw new Error(`Unknown agent: ${agent}`);
  }
  if (values.includes("all")) return ["all"];
  return [...new Set(values)] as Array<AgentName | "all">;
}

export function parseConfigScope(value: string | undefined): ConfigScope {
  if (!value) return "project";
  if (value === "project" || value === "global") return value;
  throw new Error(`Unknown config scope: ${value}`);
}

export function initAll(repoRoot: string, agents: Array<AgentName | "all">, homeDir = os.homedir(), force = false, scope: ConfigScope = "project"): InitResult {
  const absRepo = path.resolve(repoRoot);
  return {
    repoRoot: absRepo,
    project: initProject(absRepo, force),
    agents: agents.flatMap((agent) => configureAgent(agent, absRepo, homeDir, force, scope))
  };
}

function hasConfiguredFrontload(adapter: McpConfigAdapter, configPath: string | null): configPath is string {
  if (!configPath) return false;
  try {
    return adapter.hasFrontloadEntry(configPath);
  } catch {
    return false;
  }
}

function repoArgFromArgs(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repo" && typeof args[i + 1] === "string") return args[i + 1] as string;
    if (typeof arg === "string" && arg.startsWith("--repo=")) return arg.slice("--repo=".length);
  }
  return undefined;
}

function tomlTableBlock(text: string, tableName: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => tomlTableName(line) === tableName);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !isDifferentTomlTable(lines[end], tableName)) end += 1;
  return lines.slice(start, end).join("\n");
}

function existingCodexRepoArg(configPath: string): string | undefined {
  if (!fs.existsSync(configPath)) return undefined;
  const block = tomlTableBlock(fs.readFileSync(configPath, "utf8"), "mcp_servers.frontload");
  const match = block?.match(/^args\s*=\s*(\[.*\])$/m);
  if (!match) return undefined;
  try {
    return repoArgFromArgs(JSON.parse(match[1]));
  } catch {
    return undefined;
  }
}

function existingClaudeRepoArg(configPath: string): string | undefined {
  const config = readJson<Record<string, unknown>>(configPath, {});
  const servers = isJsonObject(config.mcpServers) ? config.mcpServers : {};
  const frontload = isJsonObject(servers.frontload) ? servers.frontload : {};
  return repoArgFromArgs(frontload.args);
}

function upgradeMcpEntry(agent: AgentName, configPath: string, repoRoot: string): McpEntry {
  const repo = agent === "codex" ? existingCodexRepoArg(configPath) : existingClaudeRepoArg(configPath);
  const pinnedRepo = !repo || repo === "." ? repoRoot : path.isAbsolute(repo) ? repo : path.resolve(repoRoot, repo);
  return buildMcpEntry(pinnedRepo);
}

function hasFrontloadHookForEvent(file: string, event: HookDefinition["event"]): boolean {
  const config = readJson<JsonObject>(file, {});
  const hooks = isJsonObject(config.hooks) ? config.hooks : {};
  const groups = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
  return groups.some((group) => isJsonObject(group) && Array.isArray(group.hooks) && group.hooks.some(isFrontloadHook));
}

function upgradeHookDefinitions(agent: AgentName, hooksFile: string): HookDefinition[] {
  return hookDefinitions[agent].filter((definition) => hasFrontloadHookForEvent(hooksFile, definition.event));
}

function upgradeNotes(agent: InstallResult): InstallResult {
  return {
    ...agent,
    notes: agent.notes.map((note) => note.replaceAll("after init completes", "after upgrade completes"))
  };
}

export function upgradeAll(repoRoot: string, homeDir = os.homedir()): InitResult {
  const absRepo = path.resolve(repoRoot);
  const agents: InstallResult[] = [];
  const codexProjectConfig = mcpConfigAdapters.codex.projectPath(absRepo);
  if (hasConfiguredFrontload(mcpConfigAdapters.codex, codexProjectConfig)) {
    agents.push(upgradeNotes(configureCodexAt(
      codexProjectConfig,
      homeDir,
      upgradeMcpEntry("codex", codexProjectConfig, absRepo),
      upgradeHookDefinitions("codex", path.join(homeDir, ".codex/hooks.json")),
      true,
      "project"
    )));
  }
  const codexGlobalConfig = mcpConfigAdapters.codex.globalPath(homeDir);
  if (hasConfiguredFrontload(mcpConfigAdapters.codex, codexGlobalConfig)) {
    agents.push(upgradeNotes(configureCodexAt(
      codexGlobalConfig,
      homeDir,
      upgradeMcpEntry("codex", codexGlobalConfig, absRepo),
      upgradeHookDefinitions("codex", path.join(homeDir, ".codex/hooks.json")),
      true,
      "legacy-global"
    )));
  }
  const claudeProjectConfig = mcpConfigAdapters.claude.projectPath(absRepo);
  if (hasConfiguredFrontload(mcpConfigAdapters.claude, claudeProjectConfig)) {
    agents.push(upgradeNotes(configureClaudeAt(
      absRepo,
      homeDir,
      "project",
      claudeProjectConfig,
      upgradeMcpEntry("claude", claudeProjectConfig, absRepo),
      upgradeHookDefinitions("claude", claudeSettingsPath(absRepo, homeDir, "project")),
      true
    )));
  }
  const claudeGlobalConfig = mcpConfigAdapters.claude.globalPath(homeDir);
  if (hasConfiguredFrontload(mcpConfigAdapters.claude, claudeGlobalConfig)) {
    agents.push(upgradeNotes(configureClaudeAt(
      absRepo,
      homeDir,
      "global",
      claudeGlobalConfig,
      upgradeMcpEntry("claude", claudeGlobalConfig, absRepo),
      upgradeHookDefinitions("claude", claudeSettingsPath(absRepo, homeDir, "global")),
      true
    )));
  }
  return {
    repoRoot: absRepo,
    project: [],
    agents
  };
}
