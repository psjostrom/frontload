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

function nextSteps(result: InitOutput): string[] {
  if (result.globalInstall?.action === "manual") {
    return [
      `  1. Run ${commandText(result.globalInstall)}.`,
      "  2. Run frontload init again and choose your agent."
    ];
  }
  const agents = result.agents?.map((agent) => agent.agent) ?? [];
  if (agents.includes("codex") && agents.includes("claude")) {
    return [
      "  1. Restart Codex and Claude Code.",
      "  2. Run /mcp in each editor and confirm frontload is listed.",
      "  3. In Codex, open /hooks to review and approve the Frontload command hooks."
    ];
  }
  if (agents.includes("codex")) {
    return [
      "  1. Restart Codex.",
      "  2. Run /mcp and confirm frontload is listed.",
      "  3. Open /hooks to review and approve the Frontload command hooks."
    ];
  }
  if (agents.includes("claude")) {
    return [
      "  1. Restart Claude Code.",
      "  2. Run /mcp and confirm frontload is listed."
    ];
  }
  return [
    "  1. Review frontload.config.json.",
    "  2. Run frontload index when you want to build repo context."
  ];
}

function upgradeNextSteps(result: UpgradeOutput): string[] {
  if (result.globalInstall?.action === "manual") {
    return [
      `  1. Run ${commandText(result.globalInstall)}.`,
      "  2. Run frontload upgrade again."
    ];
  }
  const agents = result.agents?.map((agent) => agent.agent) ?? [];
  if (agents.includes("codex") && agents.includes("claude")) {
    return [
      "  1. Restart Codex and Claude Code.",
      "  2. Run /mcp in each editor and confirm frontload is listed.",
      "  3. In Codex, open /hooks to review and approve the Frontload command hooks."
    ];
  }
  if (agents.includes("codex")) {
    return [
      "  1. Restart Codex.",
      "  2. Run /mcp and confirm frontload is listed.",
      "  3. Open /hooks to review and approve the Frontload command hooks."
    ];
  }
  if (agents.includes("claude")) {
    return [
      "  1. Restart Claude Code.",
      "  2. Run /mcp and confirm frontload is listed."
    ];
  }
  return [
    "  1. Run frontload init if you want to configure agent integration.",
    "  2. Run frontload doctor --dogfood after configuring an agent."
  ];
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
