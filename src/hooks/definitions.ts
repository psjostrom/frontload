import { gateMatcherForHostPhase } from "../gate/capabilities.js";

export type HookHost = "claude" | "codex";
export type HookEvent = "PreToolUse" | "PostToolUse";

export type HookCommand = {
  type: "command";
  command: string;
  args?: string[];
  timeout: number;
  statusMessage?: string;
};

export type HookDefinition = {
  event: HookEvent;
  matcher: string;
  hook: HookCommand;
};

function codexHookCommand(hook: "pre-tool-use" | "post-tool-use"): string {
  return `for start in "$PWD" "$CODEX_PROJECT_DIR"; do dir="$start"; if [ -z "$dir" ]; then continue; fi; if [ -f "$dir" ]; then dir=$(dirname "$dir"); fi; dir=$(cd "$dir" 2>/dev/null && pwd -P) || continue; while :; do if [ -d "$dir/.frontload" ]; then exec frontload hook ${hook} --host codex; fi; parent=$(dirname "$dir"); if [ "$parent" = "$dir" ]; then break; fi; dir="$parent"; done; done; exit 0`;
}

export const hookDefinitions: Record<HookHost, HookDefinition[]> = {
  claude: [
    {
      event: "PreToolUse",
      matcher: gateMatcherForHostPhase("claude", "pre"),
      hook: {
        type: "command",
        command: "frontload",
        args: ["hook", "pre-tool-use", "--host", "claude"],
        timeout: 10
      }
    },
    {
      event: "PostToolUse",
      matcher: gateMatcherForHostPhase("claude", "post"),
      hook: {
        type: "command",
        command: "frontload",
        args: ["hook", "post-tool-use", "--host", "claude"],
        timeout: 10
      }
    }
  ],
  codex: [
    {
      event: "PreToolUse",
      matcher: gateMatcherForHostPhase("codex", "pre"),
      hook: {
        type: "command",
        command: codexHookCommand("pre-tool-use"),
        timeout: 10,
        statusMessage: "Applying Frontload budget policy"
      }
    },
    {
      event: "PostToolUse",
      matcher: gateMatcherForHostPhase("codex", "post"),
      hook: {
        type: "command",
        command: codexHookCommand("post-tool-use"),
        timeout: 10,
        statusMessage: "Bounding Frontload command output"
      }
    }
  ]
};

export function hookConfigFor(host: HookHost): { hooks: Record<HookEvent, Array<{ matcher: string; hooks: HookCommand[] }>> } {
  const hooks = {
    PreToolUse: [] as Array<{ matcher: string; hooks: HookCommand[] }>,
    PostToolUse: [] as Array<{ matcher: string; hooks: HookCommand[] }>
  };
  for (const definition of hookDefinitions[host]) {
    hooks[definition.event].push({
      matcher: definition.matcher,
      hooks: [{ ...definition.hook, ...(definition.hook.args ? { args: [...definition.hook.args] } : {}) }]
    });
  }
  return { hooks };
}
