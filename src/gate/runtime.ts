import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendEvent, outputSize } from "../budget/events.js";
import { loadConfig, type FrontloadConfig } from "../config/config.js";
import { compactToolOutput, evaluate, type CompactedToolOutput, type GateOptions, type PreToolUseHookOutput } from "./gate.js";

export type GateRuntimeContext = {
  root: string;
  config: FrontloadConfig;
  gateOptions: GateOptions;
};

export type CanonicalToolCall = {
  toolName: string;
  toolInput?: unknown;
};

export type PostToolUseEvaluation = {
  compacted: CompactedToolOutput;
  replacement: unknown;
  shouldReplace: boolean;
};

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function hookOutputSize(value: unknown): { chars: number; bytes: number } {
  return outputSize(typeof value === "string" ? value : JSON.stringify(value) ?? String(value));
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function initializedRoot(start: string): string | null {
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

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function gitBoundary(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function runtimeRepoFromCwd(start = process.cwd()): string {
  const cwd = canonicalPath(path.resolve(start));
  const initialized = initializedRoot(cwd);
  const boundary = gitBoundary(cwd);
  try {
    const root = canonicalPath(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim());
    if (initialized && isWithin(root, initialized)) return initialized;
    return root;
  } catch {
    // Non-Git initialized directories still use their nearest Frontload root.
  }
  if (boundary) {
    if (initialized && isWithin(boundary, initialized)) return initialized;
    return boundary;
  }
  return initialized ?? cwd;
}

export function distRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function gateOptionsForRuntimeRepo(): GateOptions {
  const cli = path.join(distRoot(), "src/cli/index.js");
  const frontloadCommand = `${shellQuote(process.execPath)} ${shellQuote(cli)}`;
  return {
    runnerCommand: `${frontloadCommand} run --repo-from-cwd`,
    searchCommand: `${frontloadCommand} search --repo-from-cwd`,
    readCommand: `${frontloadCommand} read --repo-from-cwd`
  };
}

export function initializedGateContext(startingDirectories: string[]): GateRuntimeContext | null {
  let root: string | null = null;
  for (const directory of startingDirectories) {
    root = initializedRoot(directory);
    if (root) break;
  }
  if (!root) return null;
  const config = loadConfig(root);
  if (!config.gate.enabled) return null;
  return {
    root,
    config,
    gateOptions: gateOptionsForRuntimeRepo()
  };
}

export function evaluatePreToolUse(call: CanonicalToolCall, context: GateRuntimeContext): PreToolUseHookOutput | null {
  return evaluate(
    { tool_name: call.toolName, tool_input: call.toolInput },
    context.config,
    context.gateOptions
  );
}

export function evaluatePostToolUse(
  context: GateRuntimeContext,
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  startMs = Date.now()
): PostToolUseEvaluation {
  const compacted = compactToolOutput(toolResponse, context.config.budgets.maxToolOutputChars);
  const shouldReplace = compacted.fitsBudget && compacted.truncated;
  const replacement = shouldReplace ? compacted.output : toolResponse;
  const replacementSize = hookOutputSize(replacement);
  try {
    appendEvent(context.root, {
      source: "hook",
      operation: `post-tool-use:${toolName}`,
      inputChars: JSON.stringify(toolInput ?? {}).length,
      outputChars: replacementSize.chars,
      outputBytes: replacementSize.bytes,
      baselineBytes: hookOutputSize(toolResponse).bytes,
      baselineKind: "observed-tool-output",
      durationMs: Date.now() - startMs,
      success: true
    });
  } catch {
    // Accounting must not interfere with host hook behavior.
  }
  return {
    compacted,
    replacement,
    shouldReplace
  };
}
