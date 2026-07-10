import os from "node:os";
import path from "node:path";
import type { GlobalInstallResult, InitResult, InstallResult, WriteResult } from "../install/install.js";

type InitOutput = Partial<InitResult> & {
  globalInstall?: GlobalInstallResult;
  summary?: string;
};

type UpgradeOutput = Partial<InitResult> & {
  globalInstall?: GlobalInstallResult;
  homeDir?: string;
  summary?: string;
};

function box(title: string, body: string[]): string[] {
  const border = `+${"-".repeat(title.length + 2)}+`;
  return [
    border,
    `| ${title} |`,
    border,
    ...body
  ];
}

function displayPath(file: string, root?: string, home = os.homedir()): string {
  if (root) {
    const relative = path.relative(root, file);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  }
  if (file === home) return "~";
  if (file.startsWith(`${home}${path.sep}`)) return `~/${path.relative(home, file)}`;
  return file;
}

function commandText(globalInstall: GlobalInstallResult): string {
  return [globalInstall.command, ...globalInstall.args].join(" ");
}

function writeLine(write: WriteResult, root?: string, home?: string): string {
  return `  [${write.action}] ${displayPath(write.path, root, home)}`;
}

function globalInstallLines(globalInstall?: GlobalInstallResult): string[] {
  if (!globalInstall) return ["  [skipped] No agent setup selected, so no global command was needed."];
  if (globalInstall.action === "skipped") {
    return ["  [skipped] frontload is already available on PATH."];
  }
  return [
    `  [${globalInstall.action}] ${commandText(globalInstall)}`,
    ...globalInstall.notes.map((note) => `  ${note}`),
    ...(globalInstall.error ? [`  Error: ${globalInstall.error}`] : [])
  ];
}

function projectLines(result: InitOutput): string[] {
  if (!result.repoRoot || !result.project) return ["  Project files were not changed."];
  return [
    `  Repo: ${result.repoRoot}`,
    ...result.project.map((write) => writeLine(write, result.repoRoot))
  ];
}

function generatedStateLines(): string[] {
  return [
    "  Generated state is written to .frontload/ and ignored locally via .git/info/exclude.",
    "  Add .frontload/ to shared .gitignore rules only if your team wants that convention."
  ];
}

function agentTitle(agent: InstallResult): string {
  return `${agent.agent[0].toUpperCase()}${agent.agent.slice(1)} setup`;
}

function agentLines(agent: InstallResult, root?: string, home?: string): string[] {
  return [
    ...agent.writes.map((write) => writeLine(write, root, home)),
    ...(agent.notes.length > 0 ? ["", "  Notes:", ...agent.notes.map((note) => `  - ${note}`)] : [])
  ];
}

function agentEditorName(agent: string): string {
  if (agent === "codex") return "Codex";
  if (agent === "claude") return "Claude Code";
  return "opencode";
}

function joinEditorNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function nextSteps(result: InitOutput): string[] {
  if (result.globalInstall?.action === "manual") {
    return [
      `  1. Run ${commandText(result.globalInstall)}.`,
      "  2. Run frontload init again and choose your agent."
    ];
  }
  const agents = result.agents?.map((agent) => agent.agent) ?? [];
  if (agents.length === 0) {
    return [
      "  1. Review frontload.config.json.",
      "  2. Run frontload index when you want to build repo context."
    ];
  }
  const editorNames = agents.map(agentEditorName);
  const steps: string[] = [
    `  1. Restart ${joinEditorNames(editorNames)}.`,
    agents.length > 1
      ? "  2. Run /mcp in each editor and confirm frontload is listed."
      : "  2. Run /mcp and confirm frontload is listed."
  ];
  let stepNo = 3;
  if (agents.includes("codex")) {
    const hooksText = agents.length > 1
      ? "In Codex, open /hooks to review and approve the Frontload command hooks."
      : "Open /hooks to review and approve the Frontload command hooks.";
    steps.push(`  ${stepNo}. ${hooksText}`);
    stepNo += 1;
  }
  steps.push(agents.length > 1
    ? `  ${stepNo}. Use your agents normally; the Frontload skills tell them to use MCP dossiers, search, reads, command summaries, and diff summaries before broad raw exploration.`
    : `  ${stepNo}. Use ${editorNames[0]} normally; the Frontload skill tells the agent to use MCP dossiers, search, reads, command summaries, and diff summaries before broad raw exploration.`);
  return steps;
}

function upgradeNextSteps(result: UpgradeOutput): string[] {
  if (result.globalInstall?.action === "manual") {
    return [
      `  1. Run ${commandText(result.globalInstall)}.`,
      "  2. Run frontload upgrade again."
    ];
  }
  const agents = result.agents?.map((agent) => agent.agent) ?? [];
  if (agents.length === 0) {
    return [
      "  1. Run frontload init if you want to configure agent integration.",
      "  2. Run frontload doctor --dogfood after configuring an agent."
    ];
  }
  const editorNames = agents.map(agentEditorName);
  const steps: string[] = [
    `  1. Restart ${joinEditorNames(editorNames)}.`,
    agents.length > 1
      ? "  2. Run /mcp in each editor and confirm frontload is listed."
      : "  2. Run /mcp and confirm frontload is listed."
  ];
  if (agents.includes("codex")) {
    const hooksText = agents.length > 1
      ? "In Codex, open /hooks to review and approve the Frontload command hooks."
      : "Open /hooks to review and approve the Frontload command hooks.";
    steps.push(`  3. ${hooksText}`);
  }
  return steps;
}

export function formatInitOutput(result: InitOutput): string {
  const lines: string[] = [
    result.globalInstall?.action === "manual" ? "Frontload init needs one more step" : "Frontload init complete"
  ];
  if (result.summary) lines.push(result.summary);
  lines.push("");
  lines.push(...box("Global command", globalInstallLines(result.globalInstall)), "");

  if (result.repoRoot || result.project) {
    lines.push(...box("Generated state", generatedStateLines()), "");
    lines.push(...box("Project files", projectLines(result)), "");
  }

  if (result.agents && result.agents.length > 0) {
    for (const agent of result.agents) {
      lines.push(...box(agentTitle(agent), agentLines(agent, result.repoRoot)), "");
    }
  } else {
    lines.push(...box("Agent setup", ["  Agent setup was not changed."]), "");
  }

  lines.push(...box("Next steps", nextSteps(result)));
  return `${lines.join("\n")}\n`;
}

export function formatUpgradeOutput(result: UpgradeOutput): string {
  const lines: string[] = [
    result.globalInstall?.action === "manual" ? "Frontload upgrade needs one more step" : "Frontload upgrade complete"
  ];
  if (result.summary) lines.push(result.summary);
  lines.push("");

  if (result.globalInstall) {
    lines.push(...box("Global command", globalInstallLines(result.globalInstall)), "");
  }

  if (result.agents && result.agents.length > 0) {
    for (const agent of result.agents) {
      lines.push(...box(agentTitle(agent), agentLines(agent, result.repoRoot)), "");
    }
  } else {
    lines.push(...box("Agent setup", ["  No existing agent configuration was found to refresh."]), "");
  }

  lines.push(...box("Next steps", upgradeNextSteps(result)));
  return `${lines.join("\n")}\n`;
}
