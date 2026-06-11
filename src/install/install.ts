import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentName = "codex" | "claude";

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

type Marketplace = {
  name: string;
  interface?: { displayName?: string };
  plugins: Array<{
    name: string;
    source: { source: "local"; path: string };
    policy: { installation: "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE"; authentication: "ON_INSTALL" | "ON_USE" };
    category: string;
  }>;
};

export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (parsed.name === "agent-budget") return dir;
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

function upsertCodexMarketplace(homeDir: string, force: boolean): WriteResult {
  const file = path.join(homeDir, ".agents/plugins/marketplace.json");
  const existed = fs.existsSync(file);
  const marketplace = readJson<Marketplace>(file, {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: []
  });
  const entry = {
    name: "agent-budget",
    source: { source: "local" as const, path: "./plugins/agent-budget" },
    policy: { installation: "AVAILABLE" as const, authentication: "ON_INSTALL" as const },
    category: "Productivity"
  };
  const existing = marketplace.plugins.findIndex((plugin) => plugin.name === entry.name);
  if (existing >= 0) {
    if (!force && JSON.stringify(marketplace.plugins[existing]) === JSON.stringify(entry)) return { path: file, action: "skipped" };
    marketplace.plugins[existing] = entry;
    writeJson(file, marketplace);
    return { path: file, action: "updated" };
  }
  marketplace.plugins.push(entry);
  writeJson(file, marketplace);
  return { path: file, action: existed ? "updated" : "created" };
}

export function initProject(repoRoot: string, force = false): WriteResult[] {
  const root = packageRoot();
  const absRepo = path.resolve(repoRoot);
  const writes: WriteResult[] = [
    copyFile(path.join(root, "agent-budget.config.example.json"), path.join(absRepo, "agent-budget.config.json"), force),
    copyFile(path.join(root, "AGENTS.example.md"), path.join(absRepo, "AGENTS.md"), force),
    copyFile(path.join(root, "codex/config.example.toml"), path.join(absRepo, "codex/config.toml"), force),
    ensureDir(path.join(absRepo, ".agent-budget"))
  ];
  return writes;
}

export function installCodex(homeDir = os.homedir(), force = false): InstallResult {
  const writes: WriteResult[] = [];
  const root = packageRoot();
  copyDir(path.join(root, "plugins/codex"), path.join(homeDir, "plugins/agent-budget"), force, writes);
  writes.push(upsertCodexMarketplace(homeDir, force));
  return {
    agent: "codex",
    writes,
    notes: ["Restart Codex, open /plugins, choose the Personal marketplace, and install or enable Agent Budget."]
  };
}

export function installClaude(homeDir = os.homedir(), force = false): InstallResult {
  const writes: WriteResult[] = [];
  const root = packageRoot();
  copyDir(path.join(root, "plugins/claude"), path.join(homeDir, ".claude/plugins/agent-budget"), force, writes);
  return {
    agent: "claude",
    writes,
    notes: ["Start Claude Code with --plugin-dir ~/.claude/plugins/agent-budget, or add that plugin directory through your Claude Code plugin workflow."]
  };
}

export function installAgent(agent: AgentName | "all", homeDir = os.homedir(), force = false): InstallResult[] {
  if (agent === "all") return [installCodex(homeDir, force), installClaude(homeDir, force)];
  if (agent === "codex") return [installCodex(homeDir, force)];
  if (agent === "claude") return [installClaude(homeDir, force)];
  throw new Error(`Unknown agent: ${agent}`);
}

export function parseAgents(value: string | undefined): Array<AgentName | "all"> {
  if (!value || value === "none") return [];
  const values = value.split(",").map((part) => part.trim()).filter(Boolean);
  for (const agent of values) {
    if (!["codex", "claude", "all"].includes(agent)) throw new Error(`Unknown agent: ${agent}`);
  }
  return values as Array<AgentName | "all">;
}

export function initAll(repoRoot: string, agents: Array<AgentName | "all">, homeDir = os.homedir(), force = false): InitResult {
  return {
    repoRoot: path.resolve(repoRoot),
    project: initProject(repoRoot, force),
    agents: agents.flatMap((agent) => installAgent(agent, homeDir, force))
  };
}
