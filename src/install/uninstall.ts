import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import {
  detectPackageManager,
  mcpConfigAdapters,
  needsShellForWindowsShim,
  packageRoot,
  type AgentName,
  type PackageManager,
} from "./install.js";
import { removeStateDirIgnore } from "../utils/path.js";

export type RemovalRecord = {
  category: "repository" | "agent" | "package";
  target: string;
  status: "removed" | "absent" | "failed";
  error?: string;
};

export type UninstallArtifactsResult = {
  repoRoot: string;
  homeDir: string;
  records: RemovalRecord[];
  failures: RemovalRecord[];
};

export type GlobalUninstallCommand = {
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  command: string;
  args: string[];
};

export type PackageRemovalRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; stdio: ["ignore", "pipe", "pipe"]; shell?: boolean },
) => unknown;

export type UninstallResult = UninstallArtifactsResult;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFrontloadHook(hook: unknown): boolean {
  if (!isJsonObject(hook) || typeof hook.command !== "string") return false;
  if (/\bfrontload\s+hook\s+(?:pre-tool-use|post-tool-use)(?:\s|$)/.test(hook.command)) return true;
  return hook.command === "frontload" &&
    Array.isArray(hook.args) &&
    hook.args[0] === "hook" &&
    (hook.args[1] === "pre-tool-use" || hook.args[1] === "post-tool-use");
}

function withoutFrontloadHooks(group: unknown): unknown | null {
  if (!isJsonObject(group)) return group;
  if (!Array.isArray(group.hooks)) return group;
  const hooks = group.hooks.filter((hook) => !isFrontloadHook(hook));
  return hooks.length > 0 ? { ...group, hooks } : null;
}

function removeFrontloadHooks(file: string, boundary: string): boolean {
  if (!fs.existsSync(file)) return false;
  const currentText = fs.readFileSync(file, "utf8");
  const current = JSON.parse(currentText) as JsonObject;
  if (!isJsonObject(current.hooks)) return false;
  const hooks: JsonObject = {};
  let removed = false;
  for (const [event, value] of Object.entries(current.hooks)) {
    if (!Array.isArray(value)) {
      hooks[event] = value;
      continue;
    }
    const groups = value
      .map(withoutFrontloadHooks)
      .filter((group) => group !== null);
    hooks[event] = groups;
    removed = removed || groups.length !== value.length || JSON.stringify(groups) !== JSON.stringify(value);
  }
  if (!removed) return false;
  const next: JsonObject = { ...current };
  const nonEmptyHooks = Object.fromEntries(Object.entries(hooks).filter(([, value]) => !Array.isArray(value) || value.length > 0));
  if (Object.keys(nonEmptyHooks).length > 0) next.hooks = nonEmptyHooks;
  else delete next.hooks;
  if (Object.keys(next).length === 0) fs.rmSync(file);
  else fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  removeEmptyParents(path.dirname(file), boundary);
  return true;
}

function removeEmptyParents(start: string, boundary: string): void {
  let dir = start;
  const relative = path.relative(boundary, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  while (dir !== boundary && fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function removePath(target: string, boundary: string): boolean {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  removeEmptyParents(path.dirname(target), boundary);
  return true;
}

function bundledRelativePaths(sourceDir: string): { files: string[]; directories: string[] } {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = (current: string, relativeDir = ""): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(current, entry.name), relativePath);
        directories.push(relativePath);
      } else {
        files.push(relativePath);
      }
    }
  };
  visit(sourceDir);
  return { files, directories };
}

function removeBundledFiles(sourceDir: string, targetDir: string, boundary: string): boolean {
  if (!fs.existsSync(sourceDir) || !fs.existsSync(targetDir)) return false;
  const targetStats = fs.lstatSync(targetDir);
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) return false;
  const realTargetDir = fs.realpathSync.native(targetDir);
  const { files, directories } = bundledRelativePaths(sourceDir);
  let removed = false;
  for (const relativePath of files) {
    const target = path.join(targetDir, relativePath);
    if (!fs.existsSync(target) || fs.lstatSync(target).isDirectory()) continue;
    const realTarget = fs.realpathSync.native(target);
    const relativeTarget = path.relative(realTargetDir, realTarget);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) continue;
    fs.rmSync(target, { force: true });
    removed = true;
  }
  for (const relativePath of directories.sort((left, right) => right.length - left.length)) {
    const target = path.join(targetDir, relativePath);
    if (!fs.existsSync(target)) continue;
    const stats = fs.lstatSync(target);
    if (stats.isDirectory() && !stats.isSymbolicLink() && fs.readdirSync(target).length === 0) {
      fs.rmdirSync(target);
    }
  }
  if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory() && fs.readdirSync(targetDir).length === 0) {
    fs.rmdirSync(targetDir);
  }
  removeEmptyParents(path.dirname(targetDir), boundary);
  return removed;
}

function removeFile(target: string, boundary: string): boolean {
  if (!fs.existsSync(target) || fs.lstatSync(target).isDirectory()) return false;
  fs.rmSync(target, { force: true });
  removeEmptyParents(path.dirname(target), boundary);
  return true;
}

function cleanupEmptyConfig(file: string, boundary: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) {
    fs.rmSync(file);
    removeEmptyParents(path.dirname(file), boundary);
    return;
  }
  if (path.extname(file) === ".toml") return;
  if (/\/\/|\/\*|#/.test(text)) return;
  const parsed = JSON.parse(text) as unknown;
  const withoutEmptyObjects = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutEmptyObjects);
    if (!isJsonObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, child]) => [key, withoutEmptyObjects(child)] as const)
        .filter(([, child]) => !isJsonObject(child) || Object.keys(child).length > 0),
    );
  };
  const compact = withoutEmptyObjects(parsed);
  if (isJsonObject(compact) && Object.keys(compact).length === 0) {
    fs.rmSync(file);
    removeEmptyParents(path.dirname(file), boundary);
  }
}

function recordAction(
  records: RemovalRecord[],
  category: RemovalRecord["category"],
  target: string,
  action: () => boolean,
): void {
  try {
    records.push({ category, target, status: action() ? "removed" : "absent" });
  } catch (error) {
    records.push({
      category,
      target,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function repoArgFromArgs(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo" && typeof args[index + 1] === "string") return args[index + 1] as string;
    if (typeof arg === "string" && arg.startsWith("--repo=")) return arg.slice("--repo=".length);
  }
  return undefined;
}

function isManagedStdioEntry(entry: unknown): boolean {
  return isJsonObject(entry) &&
    entry.command === "frontload" &&
    Array.isArray(entry.args) &&
    entry.args.includes("mcp") &&
    repoArgFromArgs(entry.args) !== undefined;
}

function validateMcpConfig(agent: AgentName, configPath: string): unknown {
  if (!fs.existsSync(configPath)) return undefined;
  const text = fs.readFileSync(configPath, "utf8");
  if (agent === "codex") {
    return parseToml(text);
  }
  if (agent === "claude") {
    return JSON.parse(text);
  }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`Malformed JSONC configuration (${errors.length} parse errors)`);
  return parsed;
}

function removeManagedCodexMcp(configPath: string, parsed: unknown): boolean {
  if (!isJsonObject(parsed) || !isJsonObject(parsed.mcp_servers)) return false;
  const serverNames = new Set(Object.entries(parsed.mcp_servers)
    .filter(([name, entry]) => (name === "frontload" || name.startsWith("frontload_")) && isManagedStdioEntry(entry))
    .map(([name]) => name));
  if (serverNames.size === 0) return false;
  const current = fs.readFileSync(configPath, "utf8");
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  let skipping = false;
  const lines = current.split(/\r?\n/).filter((line) => {
    const table = line.trim().match(/^\[(.+)\](?:\s*#.*)?$/)?.[1];
    if (table) {
      const marker = "__frontload_uninstall_marker__";
      const findMarker = (value: unknown, currentPath: string[] = []): string[] | null => {
        if (!isJsonObject(value)) return null;
        if (value[marker] === true) return currentPath;
        for (const [key, child] of Object.entries(value)) {
          const found = findMarker(child, [...currentPath, key]);
          if (found) return found;
        }
        return null;
      };
      let tablePath: string[] | null = null;
      try {
        tablePath = findMarker(parseToml(`[${table}]\n${marker} = true\n`));
      } catch {
        // The complete file already parsed, so an unrecognized header is unrelated.
      }
      skipping = tablePath?.[0] === "mcp_servers" && serverNames.has(tablePath[1] ?? "");
    }
    return !skipping;
  });
  fs.writeFileSync(configPath, lines.join(eol));
  return true;
}

function hasManagedMcpEntry(agent: AgentName, parsed: unknown): boolean {
  if (!isJsonObject(parsed)) return false;
  if (agent === "claude") {
    return isJsonObject(parsed.mcpServers) && isManagedStdioEntry(parsed.mcpServers.frontload);
  }
  if (agent === "opencode") {
    if (!isJsonObject(parsed.mcp) || !isJsonObject(parsed.mcp.frontload)) return false;
    const command = parsed.mcp.frontload.command;
    return Array.isArray(command) &&
      command[0] === "frontload" &&
      command.includes("mcp") &&
      repoArgFromArgs(command) !== undefined;
  }
  return false;
}

function removeMcpConfig(records: RemovalRecord[], agent: AgentName, configPath: string | null, boundary: string): void {
  if (!configPath) return;
  recordAction(records, "agent", configPath, () => {
    const parsed = validateMcpConfig(agent, configPath);
    const removed = agent === "codex"
      ? removeManagedCodexMcp(configPath, parsed)
      : hasManagedMcpEntry(agent, parsed) && mcpConfigAdapters[agent].remove(configPath);
    if (removed) cleanupEmptyConfig(configPath, boundary);
    return removed;
  });
}

export function uninstallArtifacts(repoRoot: string, homeDir = os.homedir()): UninstallArtifactsResult {
  const absRepo = path.resolve(repoRoot);
  const absHome = path.resolve(homeDir);
  const records: RemovalRecord[] = [];

  recordAction(records, "repository", path.join(absRepo, "frontload.config.json"), () => removePath(path.join(absRepo, "frontload.config.json"), absRepo));
  recordAction(records, "repository", path.join(absRepo, ".frontload"), () => removePath(path.join(absRepo, ".frontload"), absRepo));
  recordAction(records, "repository", ".git/info/exclude:.frontload/", () => removeStateDirIgnore(absRepo));

  removeMcpConfig(records, "codex", mcpConfigAdapters.codex.projectPath(absRepo), absRepo);
  removeMcpConfig(records, "claude", mcpConfigAdapters.claude.projectPath(absRepo), absRepo);
  removeMcpConfig(records, "opencode", mcpConfigAdapters.opencode.projectPath(absRepo), absRepo);
  const claudeProjectSettings = path.join(absRepo, ".claude/settings.json");
  recordAction(records, "agent", claudeProjectSettings, () => removeFrontloadHooks(claudeProjectSettings, absRepo));

  removeMcpConfig(records, "codex", mcpConfigAdapters.codex.globalPath(absHome), absHome);
  removeMcpConfig(records, "claude", mcpConfigAdapters.claude.globalPath(absHome), absHome);
  removeMcpConfig(records, "opencode", mcpConfigAdapters.opencode.globalPath(absHome), absHome);
  const codexHooks = path.join(absHome, ".codex/hooks.json");
  const claudeSettings = path.join(absHome, ".claude/settings.json");
  recordAction(records, "agent", codexHooks, () => removeFrontloadHooks(codexHooks, absHome));
  recordAction(records, "agent", claudeSettings, () => removeFrontloadHooks(claudeSettings, absHome));

  const root = packageRoot();
  const skillPaths = [
    [path.join(root, "plugins/codex/skills/frontload"), path.join(absHome, ".codex/skills/frontload")],
    [path.join(root, "plugins/claude/skills/frontload"), path.join(absHome, ".claude/skills/frontload")],
    [path.join(root, "plugins/opencode/skills/frontload"), path.join(absHome, ".config/opencode/skills/frontload")],
  ];
  for (const [source, target] of skillPaths) {
    recordAction(records, "agent", target, () => removeBundledFiles(source, target, absHome));
  }
  const opencodePlugin = path.join(absHome, ".config/opencode/plugins/frontload-gate.js");
  recordAction(records, "agent", opencodePlugin, () => removeFile(opencodePlugin, absHome));

  return {
    repoRoot: absRepo,
    homeDir: absHome,
    records,
    failures: records.filter((record) => record.status === "failed"),
  };
}

export function globalUninstallCommands(packageManager: PackageManager = detectPackageManager()): GlobalUninstallCommand[] {
  switch (packageManager) {
    case "pnpm":
      return [{ packageManager, command: "pnpm", args: ["remove", "-g", "frontload"] }];
    case "yarn":
      return [{ packageManager, command: "yarn", args: ["global", "remove", "frontload"] }];
    case "bun":
      return [{ packageManager, command: "bun", args: ["remove", "-g", "frontload"] }];
    case "npm":
    default:
      return [{ packageManager: "npm", command: "npm", args: ["uninstall", "-g", "frontload"] }];
  }
}

function packageRemovalWasAbsent(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
  const detail = typeof error === "object" && error !== null
    ? ["message", "stderr", "stdout"]
      .map((key) => key in error ? String((error as Record<string, unknown>)[key]) : "")
      .join("\n")
    : String(error);
  return /not (?:globally )?installed|not in your dependencies|package .*not found|dependency .*not found|no package.*frontload|cannot remove .*no dependency found|isn't specified in a package\.json/i.test(detail);
}

export function uninstallGlobalPackages(
  runner: PackageRemovalRunner = execFileSync,
  packageManager: PackageManager = detectPackageManager(),
): RemovalRecord[] {
  return globalUninstallCommands(packageManager).map((removal) => {
    const target = [removal.command, ...removal.args].join(" ");
    try {
      runner(removal.command, removal.args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...(needsShellForWindowsShim(removal.command) ? { shell: true } : {}),
      });
      return { category: "package", target, status: "removed" } satisfies RemovalRecord;
    } catch (error) {
      if (packageRemovalWasAbsent(error)) {
        return { category: "package", target, status: "absent" } satisfies RemovalRecord;
      }
      return {
        category: "package",
        target,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      } satisfies RemovalRecord;
    }
  });
}

export function uninstallFrontload(
  repoRoot: string,
  homeDir = os.homedir(),
  options: { keepPackage?: boolean; runner?: PackageRemovalRunner } = {},
): UninstallResult {
  const artifacts = uninstallArtifacts(repoRoot, homeDir);
  const packageRecords = options.keepPackage ? [] : uninstallGlobalPackages(options.runner);
  const records = [...artifacts.records, ...packageRecords];
  return {
    ...artifacts,
    records,
    failures: records.filter((record) => record.status === "failed"),
  };
}
