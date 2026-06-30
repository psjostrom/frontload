import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatInitOutput } from "../../src/cli/init-output.js";

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
            { path: path.join(home, ".codex/config.toml"), action: "updated" },
            { path: path.join(home, ".codex/hooks.json"), action: "created" },
            { path: path.join(home, ".codex/skills/frontload"), action: "created" }
          ],
          notes: [
            "Restart Codex after init completes; /mcp should show the frontload server.",
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
    expect(output).toContain("[updated] ~/.codex/config.toml");
    expect(output).toContain("[created] ~/.codex/hooks.json");
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
