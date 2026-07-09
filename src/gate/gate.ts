import { FrontloadConfig } from "../config/config.js";
import { fileCategory } from "../utils/category.js";
import { shellWords } from "../utils/shell-words.js";

export type HookPermissionDecision = "allow" | "deny" | "ask";

export type PreToolUseHookOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: HookPermissionDecision;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
};

export type GateOptions = {
  /** Full command prefix for Frontload's run subcommand, without --kind. */
  runnerCommand?: string;
  /** Full command prefix for Frontload's search subcommand, without the query. */
  searchCommand?: string;
  /** Full command prefix for Frontload's read subcommand, without the path. */
  readCommand?: string;
};

export type CompactedToolOutput = {
  output: unknown;
  originalChars: number;
  outputChars: number;
  fitsBudget: boolean;
  truncated: boolean;
};

type GatePayload = {
  tool_name?: unknown;
  tool_input?: unknown;
};

function toolInput(payload: GatePayload): Record<string, unknown> {
  return payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input) ? (payload.tool_input as Record<string, unknown>) : {};
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function output(
  permissionDecision: HookPermissionDecision,
  permissionDecisionReason?: string,
  updatedInput?: Record<string, unknown>,
  additionalContext?: string
): PreToolUseHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
      ...(updatedInput ? { updatedInput } : {}),
      ...(additionalContext ? { additionalContext } : {})
    }
  };
}

function hasShellControl(command: string): boolean {
  return /[;&|<>`]/.test(command);
}

function alreadyBudgeted(command: string): boolean {
  return /\bfrontload\s+(?:run|search|read)\b/.test(command) || /dist\/src\/cli\/index\.js["']?\s+(?:run|search|read)\b/.test(command);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandKind(command: string): "test" | "typecheck" | "lint" | null {
  if (hasShellControl(command)) return null;
  if (/^(?:(?:pnpm|npm|yarn)\s+(?:run\s+)?test|(?:npx\s+)?(?:vitest|jest))(\s|$)/.test(command)) return "test";
  if (/^(?:(?:pnpm|npm|yarn)\s+(?:run\s+)?typecheck|(?:pnpm\s+|npx\s+)?tsc)(\s|$)/.test(command)) return "typecheck";
  if (/^(?:(?:pnpm|npm|yarn)\s+(?:run\s+)?lint|(?:npx\s+)?eslint)(\s|$)/.test(command)) return "lint";
  return null;
}

type GrepAnalysis = {
  recursive: boolean;
  pattern?: string;
  unsupported?: string;
};

const grepValueOptions = new Set([
  "--after-context",
  "--before-context",
  "--binary-files",
  "--context",
  "--devices",
  "--directories",
  "--exclude",
  "--exclude-dir",
  "--include",
  "--label",
  "--max-count"
]);

const grepPatternOptions = new Set(["-e", "--regexp"]);
const simpleGrepFlags = new Set(["r", "R", "n", "H", "h"]);

function markUnsupported(analysis: GrepAnalysis, reason: string): void {
  analysis.unsupported ??= reason;
}

function grepAnalysis(command: string): GrepAnalysis | null {
  const parts = shellWords(command);
  if (parts[0] !== "grep") return null;
  const analysis: GrepAnalysis = { recursive: false };
  let patternCount = 0;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--") {
      if (!analysis.pattern && parts[i + 1]) analysis.pattern = parts[i + 1];
      break;
    }
    if (grepPatternOptions.has(part)) {
      if (parts[i + 1]) analysis.pattern = parts[i + 1];
      patternCount += 1;
      i += 1;
      continue;
    }
    if (part.startsWith("--regexp=")) {
      analysis.pattern = part.slice("--regexp=".length);
      patternCount += 1;
      continue;
    }
    if (part === "-f" || part === "--file" || part.startsWith("--file=")) {
      markUnsupported(analysis, "pattern file");
      if (part === "-f" || part === "--file") i += 1;
      continue;
    }
    if (grepValueOptions.has(part)) {
      markUnsupported(analysis, `${part} option`);
      i += 1;
      continue;
    }
    if (grepValueOptions.has(part.split("=")[0])) {
      markUnsupported(analysis, `${part.split("=")[0]} option`);
      continue;
    }
    if (part.startsWith("--")) {
      if (part === "--recursive" || part === "--dereference-recursive") analysis.recursive = true;
      else if (part === "--line-number" || part === "--with-filename" || part === "--no-filename") {
        // Output-only flags are safe to drop because Frontload search always returns file paths and line numbers.
      } else {
        markUnsupported(analysis, `${part} option`);
      }
      continue;
    }
    if (part.startsWith("-") && part !== "-") {
      const flags = part.slice(1);
      if (/[rR]/.test(flags)) analysis.recursive = true;
      const e = flags.indexOf("e");
      if (e !== -1) {
        const inlinePattern = flags.slice(e + 1);
        if (inlinePattern) analysis.pattern = inlinePattern;
        else if (parts[i + 1]) {
          analysis.pattern = parts[i + 1];
          i += 1;
        }
        patternCount += 1;
      }
      const f = flags.indexOf("f");
      if (f !== -1) {
        markUnsupported(analysis, "pattern file");
        if (!flags.slice(f + 1)) i += 1;
      }
      const valueFlag = flags.match(/[ABCm]/);
      if (valueFlag) {
        markUnsupported(analysis, `-${valueFlag[0]} option`);
        if (/[ABCm]$/.test(flags) && parts[i + 1]) i += 1;
      }
      for (const flag of flags) {
        if (!simpleGrepFlags.has(flag) && flag !== "e" && flag !== "f" && !/[ABCm0-9]/.test(flag)) {
          markUnsupported(analysis, `-${flag} option`);
        }
      }
      continue;
    }
    if (!analysis.pattern) {
      analysis.pattern = part;
      patternCount += 1;
    }
    break;
  }
  if (patternCount > 1) markUnsupported(analysis, "multiple patterns");
  return analysis;
}

function findQuery(command: string): string {
  const parts = shellWords(command);
  const nameFlag = parts.findIndex((part) => part === "-name" || part === "-iname");
  if (nameFlag !== -1 && parts[nameFlag + 1]) return parts[nameFlag + 1].replace(/^\*\.?/, "");
  return ".";
}

function lsQuery(command: string): string {
  const target = shellWords(command).slice(1).find((part) => !part.startsWith("-"));
  return target ?? ".";
}

function lockfilePath(command: string): string | null {
  const parts = shellWords(command);
  if (parts[0] !== "cat") return null;
  return parts.slice(1).find((part) => /^(?:\.\/)?(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(part)) ?? null;
}

function broadShellDecision(command: string, options: GateOptions): { decision: "allow"; reason: string; command: string } | { decision: "deny"; reason: string } | null {
  const search = options.searchCommand ?? "frontload search";
  const read = options.readCommand ?? "frontload read";
  const grep = grepAnalysis(command);
  if (grep?.recursive && grep.unsupported) {
    return {
      decision: "deny",
      reason: `Recursive grep cannot be rewritten safely with ${grep.unsupported}. Use Frontload search with a focused literal query instead.`
    };
  }
  if (grep?.recursive && grep.pattern) {
    return {
      decision: "allow",
      reason: "Rewrote broad recursive grep through Frontload search so the agent receives bounded indexed results.",
      command: `${search} ${shellQuote(grep.pattern)} --limit 20`
    };
  }
  if (grep?.recursive) {
    return {
      decision: "deny",
      reason: "Recursive grep cannot be rewritten safely without a literal pattern. Use Frontload search with a focused literal query instead."
    };
  }
  if (/^find\s+\.(?:\s|$)/.test(command)) {
    return {
      decision: "allow",
      reason: "Rewrote broad find through Frontload search so the agent receives a bounded repo inventory.",
      command: `${search} ${shellQuote(findQuery(command))} --limit 50`
    };
  }
  if (/^ls\s+-(?:[A-Za-z]*R[A-Za-z]*)(?:\s|$)/.test(command)) {
    return {
      decision: "allow",
      reason: "Rewrote recursive ls through Frontload search so the agent receives bounded indexed results.",
      command: `${search} ${shellQuote(lsQuery(command))} --limit 50`
    };
  }
  const lockfile = lockfilePath(command);
  if (lockfile) {
    return {
      decision: "allow",
      reason: "Rewrote noisy lockfile cat through Frontload read so the agent receives a bounded view.",
      command: `${read} ${shellQuote(lockfile)} --budget 4000`
    };
  }
  return null;
}

function serializedChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  const serialized = JSON.stringify(value);
  return serialized?.length ?? 0;
}

function truncationMarker(removed: number, noun: "chars" | "results"): string {
  return `[Frontload truncated ${removed} ${noun}]`;
}

function compactString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let marker = truncationMarker(value.length, "chars");
  if (marker.length > maxChars) marker = "[Frontload truncated]";
  if (marker.length > maxChars) return marker.slice(0, Math.max(0, maxChars));
  const prefixChars = Math.max(0, maxChars - marker.length - 1);
  return `${value.slice(0, prefixChars)}${prefixChars ? "\n" : ""}${marker}`;
}

function compactStringArray(value: string[], maxChars: number): string[] {
  if (serializedChars(value) <= maxChars) return [...value];
  for (let keep = value.length - 1; keep >= 0; keep--) {
    const marker = truncationMarker(value.length - keep, "results");
    const candidate = [...value.slice(0, keep), marker];
    if (serializedChars(candidate) <= maxChars) return candidate;
  }
  return [];
}

function jsonClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

type ArrayCandidate = { value: unknown[] };
type StringCandidate = { parent: Record<string, unknown> | unknown[]; key: string | number; value: string };
const payloadStringFields = new Set(["content", "output", "text"]);

function reductionCandidates(
  value: unknown,
  arrays: ArrayCandidate[],
  strings: StringCandidate[],
  parent?: Record<string, unknown> | unknown[],
  key?: string | number
): void {
  if (typeof value === "string") {
    if (parent !== undefined && typeof key === "string" && payloadStringFields.has(key) && value.length > 0) {
      strings.push({ parent, key, value });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 0) arrays.push({ value });
    value.forEach((item, index) => reductionCandidates(item, arrays, strings, value, index));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [field, nested] of Object.entries(value)) {
    reductionCandidates(nested, arrays, strings, value as Record<string, unknown>, field);
  }
}

function compactStructured(value: unknown, maxChars: number): unknown {
  const output = jsonClone(value);
  if (!output || typeof output !== "object") return output;
  let reduced = false;

  while (serializedChars(output) > maxChars) {
    const arrays: ArrayCandidate[] = [];
    const strings: StringCandidate[] = [];
    reductionCandidates(output, arrays, strings);
    const array = arrays.sort((left, right) => right.value.length - left.value.length)[0];
    if (array) {
      array.value.pop();
      reduced = true;
      continue;
    }
    const string = strings.sort((left, right) => right.value.length - left.value.length)[0];
    if (string) {
      const excess = serializedChars(output) - maxChars;
      const nextLength = Math.max(0, string.value.length - Math.max(1, excess));
      string.parent[string.key as never] = compactString(string.value, nextLength) as never;
      reduced = true;
      continue;
    }
    break;
  }
  if (reduced && !Array.isArray(output) && typeof (output as Record<string, unknown>).truncated === "boolean") {
    (output as Record<string, unknown>).truncated = true;
  }
  return output;
}

export function compactToolOutput(value: unknown, maxChars: number): CompactedToolOutput {
  if (!Number.isInteger(maxChars) || maxChars < 2) {
    throw new RangeError("Tool output budget must be an integer of at least 2 characters.");
  }
  const originalChars = serializedChars(value);
  if (originalChars <= maxChars) {
    return { output: value, originalChars, outputChars: originalChars, fitsBudget: true, truncated: false };
  }

  let output: unknown;
  if (typeof value === "string") output = compactString(value, maxChars);
  else if (Array.isArray(value) && value.every((item) => typeof item === "string")) output = compactStringArray(value, maxChars);
  else if (Array.isArray(value) || (value && typeof value === "object")) output = compactStructured(value, maxChars);
  else output = value;
  const outputChars = serializedChars(output);
  const fitsBudget = outputChars <= maxChars;
  return {
    output,
    originalChars,
    outputChars,
    fitsBudget,
    truncated: fitsBudget && outputChars < originalChars
  };
}

export function evaluate(payload: GatePayload, config: Pick<FrontloadConfig, "gate">, options: GateOptions = {}): PreToolUseHookOutput | null {
  if (!config.gate.enabled) return null;

  const name = textField(payload.tool_name);
  const input = toolInput(payload);

  if (name === "Bash") {
    const command = textField(input.command).trim();
    if (!command || alreadyBudgeted(command)) return null;

    if (config.gate.rewriteCommands) {
      const kind = commandKind(command);
      if (kind) {
        const runner = options.runnerCommand ?? "frontload run";
        return output("allow", `Run ${kind} through Frontload so the agent receives a compact summary.`, {
          ...input,
          command: `${runner} --kind ${kind} -- ${command}`
        });
      }
    }

    if (config.gate.blockBroadShell) {
      const decision = broadShellDecision(command, options);
      if (decision?.decision === "allow") return output("allow", decision.reason, { ...input, command: decision.command });
      if (decision?.decision === "deny") return output("deny", decision.reason);
    }

    return null;
  }

  if (name === "Read") {
    const filePath = textField(input.file_path);
    const category = filePath ? fileCategory(filePath) : "source";
    if (config.gate.blockNoisyReads && (category === "generated" || category === "lockfile")) {
      return output(
        "deny",
        `This ${category} file is noisy. Use mcp__frontload__fl_read_budgeted with a focused query, or mcp__frontload__fl_search so the agent receives only relevant content.`
      );
    }
    const requestedLimit = typeof input.limit === "number" && input.limit > 0 ? input.limit : config.gate.maxReadLines;
    return output("allow", "Bound the source read so the agent receives a focused contiguous window.", {
      ...input,
      limit: Math.min(requestedLimit, config.gate.maxReadLines)
    });
  }

  return null;
}
