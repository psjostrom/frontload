export type GateConsumerHost = "claude" | "codex" | "opencode";
export type HookGateConsumerHost = Extract<GateConsumerHost, "claude" | "codex">;
export type GatePhase = "pre" | "post";

export type GateHostCapabilities = {
  pre: readonly string[];
  post: readonly string[];
};

export const gateCapabilities: Record<GateConsumerHost, GateHostCapabilities> = {
  claude: {
    pre: ["Read", "Bash"],
    post: ["Grep", "Glob"]
  },
  codex: {
    pre: ["Bash"],
    post: ["Bash"]
  },
  opencode: {
    pre: ["Bash"],
    post: ["Bash"]
  }
};

export function supportsGateTool(host: GateConsumerHost, phase: GatePhase, toolName: string | null): boolean {
  if (!toolName) return false;
  return gateCapabilities[host][phase].includes(toolName);
}

export function gateMatcherForHostPhase(host: HookGateConsumerHost, phase: GatePhase): string {
  const tools = gateCapabilities[host][phase];
  const matcher = tools.join("|");
  return host === "codex" ? `^${matcher}$` : matcher;
}
