import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/config.js";
import { evaluate } from "./gate.js";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function repoRoot(payload: Record<string, unknown>): string {
  const input = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input) ? (payload.tool_input as Record<string, unknown>) : {};
  return path.resolve(
    stringValue(process.env.CLAUDE_PROJECT_DIR) ??
      stringValue(process.env.CODEX_PROJECT_DIR) ??
      stringValue(payload.cwd) ??
      stringValue(input.cwd) ??
      process.cwd()
  );
}

function distRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => resolve(input));
  });
}

export async function runPreToolUseHook(rawInput?: string): Promise<string | null> {
  try {
    const raw = rawInput ?? (await readStdin());
    const payload = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const root = repoRoot(payload);
    if (!fs.existsSync(path.join(root, ".frontload"))) return null;

    const config = loadConfig(root);
    if (!config.gate.enabled) return null;

    const cli = path.join(distRoot(), "src/cli/index.js");
    const frontloadCommand = `${shellQuote(process.execPath)} ${shellQuote(cli)}`;
    const decision = evaluate(payload, config, {
      runnerCommand: `${frontloadCommand} run --repo ${shellQuote(root)}`,
      searchCommand: `${frontloadCommand} search --repo ${shellQuote(root)}`,
      readCommand: `${frontloadCommand} read --repo ${shellQuote(root)}`
    });
    return decision ? JSON.stringify(decision) : null;
  } catch {
    return null;
  }
}
