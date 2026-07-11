import fs from "node:fs";
import path from "node:path";
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

export function distRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function gateOptionsForRoot(root: string): GateOptions {
  const cli = path.join(distRoot(), "src/cli/index.js");
  const frontloadCommand = `${shellQuote(process.execPath)} ${shellQuote(cli)}`;
  return {
    runnerCommand: `${frontloadCommand} run --repo ${shellQuote(root)}`,
    searchCommand: `${frontloadCommand} search --repo ${shellQuote(root)}`,
    readCommand: `${frontloadCommand} read --repo ${shellQuote(root)}`
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
    gateOptions: gateOptionsForRoot(root)
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
