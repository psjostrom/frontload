import path from "node:path";
import { agentIntegrationsPaused } from "../../product/status.js";
import { supportsGateTool } from "../capabilities.js";
import { evaluatePostToolUse, evaluatePreToolUse, initializedGateContext } from "../runtime.js";

type OpenCodePluginContext = {
  directory?: string;
};

type OpenCodeToolInput = {
  tool?: unknown;
};

type OpenCodeToolOutput = {
  args?: unknown;
  output?: unknown;
};

type OpenCodeHook = (input: OpenCodeToolInput, output: OpenCodeToolOutput) => void | Promise<void>;

type OpenCodeHooks = Record<"tool.execute.before" | "tool.execute.after", OpenCodeHook>;

function argsObject(output: OpenCodeToolOutput): Record<string, unknown> | null {
  return output.args && typeof output.args === "object" && !Array.isArray(output.args)
    ? output.args as Record<string, unknown>
    : null;
}

function canonicalToolName(tool: unknown): string | null {
  return tool === "bash" ? "Bash" : null;
}

export async function FrontloadGate({ directory }: OpenCodePluginContext): Promise<Partial<OpenCodeHooks>> {
  if (agentIntegrationsPaused) return {};
  const startDirectory = typeof directory === "string" && directory.trim() ? path.resolve(directory) : process.cwd();
  let context: ReturnType<typeof initializedGateContext>;
  try {
    context = initializedGateContext([startDirectory]);
  } catch {
    return {};
  }
  if (!context) return {};

  return {
    "tool.execute.before": async (input, output) => {
      const toolName = canonicalToolName(input.tool);
      if (!toolName || !supportsGateTool("opencode", "pre", toolName)) return;
      const args = argsObject(output);
      if (!args) return;
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) return;

      let decision: ReturnType<typeof evaluatePreToolUse>;
      try {
        decision = evaluatePreToolUse({ toolName, toolInput: args }, context);
      } catch {
        return;
      }
      if (!decision) return;

      const hookOutput = decision.hookSpecificOutput;
      if (hookOutput.permissionDecision === "deny") {
        throw new Error(`Frontload gate: ${hookOutput.permissionDecisionReason ?? "blocked"}`);
      }
      if (hookOutput.updatedInput) {
        Object.assign(args, hookOutput.updatedInput);
      }
    },

    "tool.execute.after": async (input, output) => {
      const start = Date.now();
      const toolName = canonicalToolName(input.tool);
      if (!toolName || !supportsGateTool("opencode", "post", toolName)) return;
      if (!("output" in output)) return;

      let result: ReturnType<typeof evaluatePostToolUse>;
      try {
        result = evaluatePostToolUse(context, toolName, argsObject(output) ?? {}, output.output, start);
      } catch {
        return;
      }
      if (result.shouldReplace) output.output = result.replacement;
    }
  };
}
