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

export const hookDefinitions: Record<HookHost, HookDefinition[]> = {
  claude: [
    {
      event: "PreToolUse",
      matcher: "Read|Bash",
      hook: {
        type: "command",
        command: "frontload",
        args: ["hook", "pre-tool-use", "--host", "claude"],
        timeout: 10
      }
    },
    {
      event: "PostToolUse",
      matcher: "Grep|Glob",
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
      matcher: "^Bash$",
      hook: {
        type: "command",
        command: "frontload hook pre-tool-use --host codex",
        timeout: 10,
        statusMessage: "Applying Frontload budget policy"
      }
    },
    {
      event: "PostToolUse",
      matcher: "^Bash$",
      hook: {
        type: "command",
        command: "frontload hook post-tool-use --host codex",
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
