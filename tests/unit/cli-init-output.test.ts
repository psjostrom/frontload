import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatInitOutput, formatUpgradeOutput } from "../../src/cli/init-output.js";

describe("init output formatting", () => {
  it("renders a human-friendly setup summary", () => {
    const home = os.homedir();
    const repo = path.join(home, "code/springa");
    const output = formatInitOutput({
      globalInstall: {
        action: "installed",
        command: "npm",
        args: ["install", "-g", "frontload"],
        notes: ["Installed frontload globally so editor MCP configs can launch it by name."]
      },
      repoRoot: repo,
      project: [
        { path: path.join(repo, "frontload.config.json"), action: "created" },
        { path: path.join(repo, "AGENTS.md"), action: "skipped" },
        { path: path.join(repo, ".frontload"), action: "created" }
      ],
      agents: [
        {
          agent: "codex",
          writes: [
            { path: path.join(repo, ".codex/config.toml"), action: "updated" },
            { path: path.join(home, ".codex/hooks.json"), action: "created" },
            { path: path.join(home, ".codex/skills/frontload"), action: "created" }
          ],
          notes: [
            "Codex MCP config was written to project .codex/config.toml; hooks and the Frontload skill were written to your global Codex config.",
            "Restart Codex after init completes; /mcp should show the frontload server for this repo.",
            "Open /hooks once to review and approve the Frontload command hooks."
          ]
        }
      ]
    });

    expect(output).toContain("Frontload init complete");
    expect(output).toContain("+----------------+");
    expect(output).toContain("| Global command |");
    expect(output).toContain("[installed] npm install -g frontload");
    expect(output).toContain("| Project files |");
    expect(output).toContain(`Repo: ${repo}`);
    expect(output).toContain("[created] frontload.config.json");
    expect(output).toContain("[skipped] AGENTS.md");
    expect(output).toContain("| Codex setup |");
    expect(output).toContain("[updated] .codex/config.toml");
    expect(output).toContain("[created] ~/.codex/hooks.json");
    expect(output).toContain("project .codex/config.toml");
    expect(output).toContain("global Codex config");
    expect(output).toContain("Next steps");
    expect(output).toContain("1. Restart Codex.");
    expect(output).toContain("Open /hooks to review and approve");
    expect(output).not.toContain("\"globalInstall\"");
  });

  it("renders the manual install path without agent writes", () => {
    const output = formatInitOutput({
      summary: "Frontload was not installed globally; MCP config was not written.",
      globalInstall: {
        action: "manual",
        command: "npm",
        args: ["install", "-g", "frontload"],
        notes: ["Install frontload globally before restarting your editor: npm install -g frontload"]
      }
    });

    expect(output).toContain("Frontload init needs one more step");
    expect(output).toContain("[manual] npm install -g frontload");
    expect(output).toContain("Install frontload globally before restarting your editor");
    expect(output).toContain("Agent setup was not changed.");
  });

  it("includes next steps for both editors when both agents are configured", () => {
    const output = formatInitOutput({
      agents: [
        { agent: "codex", writes: [], notes: [] },
        { agent: "claude", writes: [], notes: [] }
      ]
    });

    expect(output).toContain("Restart Codex and Claude Code.");
    expect(output).toContain("Run /mcp in each editor");
  });
});

describe("upgrade output formatting", () => {
  it("renders a successful Codex upgrade without project files or JSON keys", () => {
    const home = os.homedir();
    const repo = path.join(home, "code/springa");
    const output = formatUpgradeOutput({
      summary: "Frontload and existing agent configuration were updated.",
      globalInstall: {
        action: "updated",
        command: "npm",
        args: ["install", "-g", "frontload@latest"],
        notes: ["Updated frontload globally."]
      },
      repoRoot: repo,
      project: [],
      agents: [
        {
          agent: "codex",
          writes: [
            { path: path.join(home, ".codex/config.toml"), action: "updated" },
            { path: path.join(home, ".codex/hooks.json"), action: "updated" },
            { path: path.join(home, ".codex/skills/frontload"), action: "updated" }
          ],
          notes: [
            "Restart Codex after upgrade completes; /mcp should show the frontload server.",
            "Open /hooks once to review and approve the Frontload command hooks."
          ]
        }
      ]
    });

    expect(output).toContain("Frontload upgrade complete");
    expect(output).toContain("Frontload and existing agent configuration were updated.");
    expect(output).toContain("| Global command |");
    expect(output).toContain("[updated] npm install -g frontload@latest");
    expect(output).toContain("| Codex setup |");
    expect(output).toContain("[updated] ~/.codex/config.toml");
    expect(output).toContain("Restart Codex after upgrade completes");
    expect(output).toContain("| Next steps |");
    expect(output).toContain("1. Restart Codex.");
    expect(output).not.toContain("| Project files |");
    expect(output).not.toContain(`Repo: ${repo}`);
    expect(output).not.toContain("\"agents\"");
    expect(output).not.toContain("\"repoRoot\"");
    expect(output).not.toContain("\"writes\"");
  });

  it("does not render override home paths as the user's home", () => {
    const overrideHome = path.join(path.dirname(os.homedir()), "frontload-test-home");
    const codexConfig = path.join(overrideHome, ".codex/config.toml");
    const output = formatUpgradeOutput({
      homeDir: overrideHome,
      agents: [
        {
          agent: "codex",
          writes: [{ path: codexConfig, action: "updated" }],
          notes: []
        }
      ]
    });

    expect(output).toContain(`[updated] ${codexConfig}`);
    expect(output).not.toContain("[updated] ~/.codex/config.toml");
  });

  it("renders next steps for both Codex and Claude upgrades", () => {
    const output = formatUpgradeOutput({
      agents: [
        { agent: "codex", writes: [], notes: [] },
        { agent: "claude", writes: [], notes: [] }
      ]
    });

    expect(output).toContain("| Codex setup |");
    expect(output).toContain("| Claude setup |");
    expect(output).toContain("Restart Codex and Claude Code.");
    expect(output).toContain("Run /mcp in each editor");
  });

  it("renders a friendly message when no existing agent configuration is found", () => {
    const output = formatUpgradeOutput({
      globalInstall: {
        action: "updated",
        command: "npm",
        args: ["install", "-g", "frontload@latest"],
        notes: []
      },
      agents: []
    });

    expect(output).toContain("| Agent setup |");
    expect(output).toContain("No existing agent configuration was found to refresh.");
    expect(output).not.toContain("| Project files |");
    expect(output).not.toContain("\"agents\"");
  });

  it("renders the declined global upgrade as a manual command", () => {
    const output = formatUpgradeOutput({
      summary: "Frontload was not upgraded globally; agent configuration was not refreshed.",
      globalInstall: {
        action: "manual",
        command: "pnpm",
        args: ["add", "-g", "frontload@latest"],
        notes: ["Upgrade frontload manually before restarting your editor: pnpm add -g frontload@latest"]
      }
    });

    expect(output).toContain("Frontload upgrade needs one more step");
    expect(output).toContain("[manual] pnpm add -g frontload@latest");
    expect(output).toContain("Upgrade frontload manually");
    expect(output).toContain("Run pnpm add -g frontload@latest.");
    expect(output).not.toContain("\"globalInstall\"");
  });
});
