import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initAll, initProject, installAgent, installCodex, parseAgents } from "../../src/install/install.js";

describe("installer", () => {
  it("initializes project files and onboarded state", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "abg-init-"));
    const result = initProject(repo);
    expect(result.map((write) => path.relative(repo, write.path))).toEqual([
      "agent-budget.config.json",
      "AGENTS.md",
      "codex/config.toml",
      ".agent-budget"
    ]);
    expect(fs.existsSync(path.join(repo, "agent-budget.config.json"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".agent-budget"))).toBe(true);
  });

  it("installs the Codex adapter through a personal marketplace", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "abg-home-"));
    const result = installCodex(home);
    const marketplaceFile = path.join(home, ".agents/plugins/marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));

    expect(fs.existsSync(path.join(home, "plugins/agent-budget/.codex-plugin/plugin.json"))).toBe(true);
    expect(marketplace.plugins).toContainEqual({
      name: "agent-budget",
      source: { source: "local", path: "./plugins/agent-budget" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity"
    });
    expect(result.notes[0]).toContain("Restart Codex");
  });

  it("installs all supported agent adapters from init", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "abg-init-all-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "abg-home-all-"));
    const result = initAll(repo, ["all"], home);
    expect(result.agents.map((agent) => agent.agent)).toEqual(["codex", "claude"]);
    expect(fs.existsSync(path.join(home, "plugins/agent-budget/.codex-plugin/plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude/plugins/agent-budget/.claude-plugin/plugin.json"))).toBe(true);
  });

  it("parses agent lists", () => {
    expect(parseAgents("codex,claude")).toEqual(["codex", "claude"]);
    expect(parseAgents("none")).toEqual([]);
    expect(() => parseAgents("cursor")).toThrow("Unknown agent");
  });

  it("rejects unknown install targets", () => {
    expect(() => installAgent("cursor" as never, fs.mkdtempSync(path.join(os.tmpdir(), "abg-home-bad-")))).toThrow();
  });
});
