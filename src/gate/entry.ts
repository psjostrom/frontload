import path from "node:path";
import { supportsGateTool } from "./capabilities.js";
import { evaluatePostToolUse, evaluatePreToolUse, initializedGateContext, stringValue } from "./runtime.js";

export type HookHost = "claude" | "codex";

export function parseHookHost(value: string): HookHost {
  if (value === "claude" || value === "codex") return value;
  throw new Error(`Unknown hook host: ${value}`);
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

export async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => resolve(input));
  });
}

export async function runPreToolUseHook(host: HookHost, rawInput?: string): Promise<string | null> {
  try {
    const raw = rawInput ?? (await readStdin());
    const payload = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const name = stringValue(payload.tool_name);
    if (!name || !supportsGateTool(host, "pre", name)) return null;
    const initialized = initializedGateContext(startingDirectories(payload, host));
    if (!initialized) return null;
    const decision = evaluatePreToolUse({ toolName: name, toolInput: payload.tool_input }, initialized);
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
    if (!name || !supportsGateTool(host, "post", name)) return null;
    const initialized = initializedGateContext(startingDirectories(payload, host));
    if (!initialized || !("tool_response" in payload)) return null;
    if (host === "codex" && typeof payload.tool_response !== "string") return null;

    const result = evaluatePostToolUse(initialized, name, payload.tool_input, payload.tool_response, start);
    if (!result.shouldReplace) return null;
    if (host === "claude") {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: result.replacement
        }
      });
    }
    return JSON.stringify({
      decision: "block",
      reason: result.replacement
    });
  } catch {
    return null;
  }
}
