import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, outputSize } from "../budget/events.js";
import { loadConfig } from "../config/config.js";
import { compactToolOutput, evaluate } from "./gate.js";

export type HookHost = "claude" | "codex";

export function parseHookHost(value: string): HookHost {
  if (value === "claude" || value === "codex") return value;
  throw new Error(`Unknown hook host: ${value}`);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function hookOutputSize(value: unknown): { chars: number; bytes: number } {
  return outputSize(typeof value === "string" ? value : JSON.stringify(value) ?? String(value));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function startingDirectories(payload: Record<string, unknown>, host: HookHost): string[] {
  const input = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input) ? (payload.tool_input as Record<string, unknown>) : {};
  const hostProjectDir = host === "claude" ? process.env.CLAUDE_PROJECT_DIR : process.env.CODEX_PROJECT_DIR;
  const explicitToolCwds = [stringValue(input.workdir), stringValue(input.cwd)].filter((value): value is string => !!value);
  if (explicitToolCwds.length) return explicitToolCwds.map((value) => path.resolve(value));
  const payloadCwd = stringValue(payload.cwd);
  const fallbackDirs = [payloadCwd, payloadCwd ? null : process.cwd(), stringValue(hostProjectDir)].filter((value): value is string => !!value);
  return fallbackDirs.map((value) => path.resolve(value));
}

function initializedRoot(start: string): string | null {
  let current = path.resolve(start);
  try {
    if (fs.statSync(current).isFile()) current = path.dirname(current);
  } catch {
    return null;
  }
  while (true) {
    if (fs.existsSync(path.join(current, ".frontload"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
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

function initializedConfig(payload: Record<string, unknown>, host: HookHost): { root: string; config: ReturnType<typeof loadConfig> } | null {
  let root: string | null = null;
  for (const directory of startingDirectories(payload, host)) {
    root = initializedRoot(directory);
    if (root) break;
  }
  if (!root) return null;
  const config = loadConfig(root);
  if (!config.gate.enabled) return null;
  return { root, config };
}

export async function runPreToolUseHook(host: HookHost, rawInput?: string): Promise<string | null> {
  try {
    const raw = rawInput ?? (await readStdin());
    const payload = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const name = stringValue(payload.tool_name);
    if ((host === "codex" && name !== "Bash") || (host === "claude" && name !== "Bash" && name !== "Read")) return null;
    const initialized = initializedConfig(payload, host);
    if (!initialized) return null;
    const { root, config } = initialized;

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

export async function runPostToolUseHook(host: HookHost, rawInput?: string): Promise<string | null> {
  const start = Date.now();
  try {
    const raw = rawInput ?? (await readStdin());
    const payload = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const name = stringValue(payload.tool_name);
    if ((host === "codex" && name !== "Bash") || (host === "claude" && name !== "Grep" && name !== "Glob")) return null;
    const initialized = initializedConfig(payload, host);
    if (!initialized || !("tool_response" in payload)) return null;
    if (host === "codex" && typeof payload.tool_response !== "string") return null;

    const compacted = compactToolOutput(payload.tool_response, initialized.config.budgets.maxToolOutputChars);
    const replacement = compacted.fitsBudget && compacted.truncated ? compacted.output : payload.tool_response;
    const replacementSize = hookOutputSize(replacement);
    try {
      appendEvent(initialized.root, {
        source: "hook",
        operation: `post-tool-use:${name}`,
        inputChars: JSON.stringify(payload.tool_input ?? {}).length,
        outputChars: replacementSize.chars,
        outputBytes: replacementSize.bytes,
        baselineBytes: hookOutputSize(payload.tool_response).bytes,
        baselineKind: "observed-tool-output",
        durationMs: Date.now() - start,
        success: true
      });
    } catch {
      // Accounting must not interfere with host hook behavior.
    }
    if (!compacted.fitsBudget || !compacted.truncated) return null;
    if (host === "claude") {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: compacted.output
        }
      });
    }
    return JSON.stringify({
      decision: "block",
      reason: compacted.output
    });
  } catch {
    return null;
  }
}
