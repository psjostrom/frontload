import { FrontloadConfig } from "../config/config.js";
import { fileCategory } from "../utils/category.js";

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

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    words.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\"/g, "\""));
  }
  return words;
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

function grepAnalysis(command: string): GrepAnalysis | null {
  const parts = shellWords(command);
  if (parts[0] !== "grep") return null;
  const analysis: GrepAnalysis = { recursive: false };
  const valueOptions = new Set([
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

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--") {
      if (!analysis.pattern && parts[i + 1]) analysis.pattern = parts[i + 1];
      break;
    }
    if (part === "-e" || part === "--regexp") {
      if (parts[i + 1]) analysis.pattern = parts[i + 1];
      i += 1;
      continue;
    }
    if (part.startsWith("--regexp=")) {
      analysis.pattern = part.slice("--regexp=".length);
      continue;
    }
    if (part === "-f" || part === "--file" || part.startsWith("--file=")) {
      analysis.unsupported = "pattern file";
      if (part === "-f" || part === "--file") i += 1;
      continue;
    }
    if (valueOptions.has(part)) {
      i += 1;
      continue;
    }
    if (valueOptions.has(part.split("=")[0])) continue;
    if (part.startsWith("--")) {
      if (part === "--recursive" || part === "--dereference-recursive") analysis.recursive = true;
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
      }
      const f = flags.indexOf("f");
      if (f !== -1) {
        analysis.unsupported = "pattern file";
        if (!flags.slice(f + 1)) i += 1;
      }
      const valueFlag = flags.match(/[ABCm]$/);
      if (valueFlag && !/\d$/.test(flags) && parts[i + 1]) i += 1;
      continue;
    }
    if (!analysis.pattern) analysis.pattern = part;
    break;
  }
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
      reason: "Rewrote broad recursive grep through Frontload search so Claude receives bounded indexed results.",
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
      reason: "Rewrote broad find through Frontload search so Claude receives a bounded repo inventory.",
      command: `${search} ${shellQuote(findQuery(command))} --limit 50`
    };
  }
  if (/^ls\s+-(?:[A-Za-z]*R[A-Za-z]*)(?:\s|$)/.test(command)) {
    return {
      decision: "allow",
      reason: "Rewrote recursive ls through Frontload search so Claude receives bounded indexed results.",
      command: `${search} ${shellQuote(lsQuery(command))} --limit 50`
    };
  }
  const lockfile = lockfilePath(command);
  if (lockfile) {
    return {
      decision: "allow",
      reason: "Rewrote noisy lockfile cat through Frontload read so Claude receives a bounded view.",
      command: `${read} ${shellQuote(lockfile)} --budget 4000`
    };
  }
  return null;
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
        return output("allow", `Run ${kind} through Frontload so Claude receives a compact summary.`, {
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
        `This ${category} file is noisy. Use mcp__frontload__fl_read_budgeted with a focused query, or mcp__frontload__fl_search before reading it.`
      );
    }
  }

  return null;
}
