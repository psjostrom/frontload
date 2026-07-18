import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  globalUninstallCommands,
  uninstallArtifacts,
  uninstallFrontload,
  uninstallGlobalPackages,
  type PackageRemovalRunner,
} from "../../src/install/uninstall.js";
import { stateExcludeStatus } from "../../src/utils/path.js";

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function initializedRepo(): Promise<{ repo: string; home: string }> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-uninstall-repo-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-uninstall-home-"));
  await execa("git", ["init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "frontload.config.json"), "{}\n");
  fs.mkdirSync(path.join(repo, ".frontload/logs"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".frontload/logs/test.log"), "generated\n");
  fs.appendFileSync(path.join(repo, ".git/info/exclude"), "keep-me\n.frontload/\n");
  return { repo, home };
}

describe("Frontload uninstall", () => {
  it("removes repository artifacts while preserving unrelated agent config", async () => {
    const { repo, home } = await initializedRepo();
    const codexConfig = path.join(repo, ".codex/config.toml");
    const claudeConfig = path.join(repo, ".mcp.json");
    const claudeSettings = path.join(repo, ".claude/settings.json");
    const opencodeConfig = path.join(repo, "opencode.jsonc");

    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, [
      "[mcp_servers.keep]",
      'command = "keep"',
      "",
      "[mcp_servers.frontload_repo]",
      'command = "frontload"',
      `args = ["mcp", "--repo", "${repo}"]`,
      "",
    ].join("\n"));
    writeJson(claudeConfig, {
      mcpServers: {
        keep: { command: "keep" },
        frontload: { type: "stdio", command: "frontload", args: ["mcp", "--repo", repo] },
      },
    });
    writeJson(claudeSettings, {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "frontload hook pre-tool-use --host claude" }] },
          { matcher: "Read", hooks: [{ type: "command", command: "keep" }] },
          "keep-unknown-entry",
        ],
      },
      theme: "dark",
    });
    fs.writeFileSync(opencodeConfig, [
      "{",
      "  // keep this comment",
      '  "mcp": {',
      '    "keep": { "type": "local", "command": ["keep"] },',
      `    "frontload": { "type": "local", "command": ["frontload", "mcp", "--repo", "${repo}"] }`,
      "  }",
      "}",
      "",
    ].join("\n"));

    const result = uninstallArtifacts(repo, home);

    expect(result.failures).toEqual([]);
    expect(fs.existsSync(path.join(repo, "frontload.config.json"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".frontload"))).toBe(false);
    expect(stateExcludeStatus(repo).ignored).toBe(false);
    expect(fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf8")).toContain("keep-me");
    expect(fs.readFileSync(codexConfig, "utf8")).toContain("mcp_servers.keep");
    expect(fs.readFileSync(codexConfig, "utf8")).not.toContain("frontload_repo");
    expect(JSON.parse(fs.readFileSync(claudeConfig, "utf8"))).toEqual({
      mcpServers: { keep: { command: "keep" } },
    });
    expect(JSON.parse(fs.readFileSync(claudeSettings, "utf8"))).toEqual({
      hooks: { PreToolUse: [
        { matcher: "Read", hooks: [{ type: "command", command: "keep" }] },
        "keep-unknown-entry",
      ] },
      theme: "dark",
    });
    expect(fs.readFileSync(opencodeConfig, "utf8")).toContain("keep this comment");
    expect(fs.readFileSync(opencodeConfig, "utf8")).toContain('"keep"');
    expect(fs.readFileSync(opencodeConfig, "utf8")).not.toContain('"frontload"');

    const second = uninstallArtifacts(repo, home);
    expect(second.failures).toEqual([]);
    expect(second.records.every((record) => record.status === "absent")).toBe(true);
  });

  it("removes global agent artifacts while preserving unrelated settings", async () => {
    const { repo, home } = await initializedRepo();
    const codexConfig = path.join(home, ".codex/config.toml");
    const codexHooks = path.join(home, ".codex/hooks.json");
    const claudeConfig = path.join(home, ".claude.json");
    const claudeSettings = path.join(home, ".claude/settings.json");
    const opencodeConfig = path.join(home, ".config/opencode/opencode.json");
    const skillPaths = [
      path.join(home, ".codex/skills/frontload"),
      path.join(home, ".claude/skills/frontload"),
      path.join(home, ".config/opencode/skills/frontload"),
    ];
    const pluginPath = path.join(home, ".config/opencode/plugins/frontload-gate.js");

    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, [
      "[mcp_servers.keep]",
      'command = "keep"',
      "",
      "[mcp_servers.frontload]",
      'command = "frontload"',
      `args = ["mcp", "--repo", "${repo}"]`,
      "",
    ].join("\n"));
    writeJson(codexHooks, {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "frontload", args: ["hook", "pre-tool-use"] }] },
          { matcher: "Read", hooks: [{ type: "command", command: "keep" }] },
        ],
      },
    });
    writeJson(claudeConfig, {
      mcpServers: {
        keep: { command: "keep" },
        frontload: { command: "frontload", args: ["mcp", "--repo", repo] },
      },
    });
    writeJson(claudeSettings, {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "frontload hook post-tool-use --host claude" }] },
        ],
      },
      model: "keep",
    });
    writeJson(opencodeConfig, {
      mcp: {
        keep: { type: "local", command: ["keep"] },
        frontload: { type: "local", command: ["frontload", "mcp", "--repo", repo] },
      },
    });
    for (const skillPath of skillPaths) {
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, "SKILL.md"), "Frontload\n");
    }
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, "FrontloadGate\n");

    const result = uninstallArtifacts(repo, home);

    expect(result.failures).toEqual([]);
    expect(skillPaths.every((skillPath) => !fs.existsSync(skillPath))).toBe(true);
    expect(fs.existsSync(pluginPath)).toBe(false);
    expect(fs.readFileSync(codexConfig, "utf8")).toContain("mcp_servers.keep");
    expect(fs.readFileSync(codexConfig, "utf8")).not.toContain("mcp_servers.frontload");
    expect(JSON.parse(fs.readFileSync(codexHooks, "utf8"))).toEqual({
      hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "keep" }] }] },
    });
    expect(JSON.parse(fs.readFileSync(claudeConfig, "utf8"))).toEqual({
      mcpServers: { keep: { command: "keep" } },
    });
    expect(JSON.parse(fs.readFileSync(claudeSettings, "utf8"))).toEqual({ model: "keep" });
    expect(JSON.parse(fs.readFileSync(opencodeConfig, "utf8"))).toEqual({
      mcp: { keep: { type: "local", command: ["keep"] } },
    });
  });
  it("reports malformed shared config without overwriting it", async () => {
    const { repo, home } = await initializedRepo();
    const codexConfig = path.join(repo, ".codex/config.toml");
    const claudeConfig = path.join(repo, ".mcp.json");
    const skillPath = path.join(home, ".codex/skills/frontload");
    const malformedToml = "[mcp_servers.frontload\ncommand = \"frontload\"\n";
    const malformedJson = '{ "mcpServers": { "frontload": } }\n';
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, malformedToml);
    fs.writeFileSync(claudeConfig, malformedJson);
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, "SKILL.md"), "Frontload\n");

    const result = uninstallArtifacts(repo, home);

    expect(fs.readFileSync(codexConfig, "utf8")).toBe(malformedToml);
    expect(fs.readFileSync(claudeConfig, "utf8")).toBe(malformedJson);
    expect(result.failures.map((failure) => failure.target)).toEqual(expect.arrayContaining([
      codexConfig,
      claudeConfig,
    ]));
    expect(fs.existsSync(skillPath)).toBe(false);
    expect(fs.existsSync(path.join(repo, ".frontload"))).toBe(false);
  });

  it("removes global package installs across supported package managers", () => {
    expect(globalUninstallCommands()).toEqual([
      { packageManager: "npm", command: "npm", args: ["uninstall", "-g", "frontload"] },
      { packageManager: "pnpm", command: "pnpm", args: ["remove", "-g", "frontload"] },
      { packageManager: "yarn", command: "yarn", args: ["global", "remove", "frontload"] },
      { packageManager: "bun", command: "bun", args: ["remove", "-g", "frontload"] },
    ]);
    const calls: string[] = [];
    const runner: PackageRemovalRunner = (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "pnpm") throw Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" });
      if (command === "yarn") throw Object.assign(new Error("not installed"), { stderr: 'Package "frontload" is not in your dependencies' });
      if (command === "bun") throw Object.assign(new Error("permission denied"), { stderr: "permission denied" });
      return "";
    };

    const records = uninstallGlobalPackages(runner);

    expect(calls).toEqual([
      "npm uninstall -g frontload",
      "pnpm remove -g frontload",
      "yarn global remove frontload",
      "bun remove -g frontload",
    ]);
    expect(records.map(({ target, status }) => ({ target, status }))).toEqual([
      { target: "npm uninstall -g frontload", status: "removed" },
      { target: "pnpm remove -g frontload", status: "absent" },
      { target: "yarn global remove frontload", status: "absent" },
      { target: "bun remove -g frontload", status: "failed" },
    ]);
  });

  it("keeps the package when requested", async () => {
    const { repo, home } = await initializedRepo();
    const calls: string[] = [];
    const runner: PackageRemovalRunner = (command) => {
      calls.push(command);
      return "";
    };

    const result = uninstallFrontload(repo, home, { keepPackage: true, runner });

    expect(calls).toEqual([]);
    expect(result.records.some((record) => record.category === "package")).toBe(false);
    expect(fs.existsSync(path.join(repo, ".frontload"))).toBe(false);
  });

  it("treats supported package-manager missing-package diagnostics as absent", () => {
    const diagnostics: Record<string, string> = {
      npm: "npm error package frontload is not installed",
      pnpm: "ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS Cannot remove 'frontload': no dependency found",
      yarn: "This module isn't specified in a package.json file.",
      bun: 'error: package "frontload" is not installed',
    };
    const runner: PackageRemovalRunner = (command) => {
      throw Object.assign(new Error("remove failed"), { stderr: diagnostics[command] });
    };

    expect(uninstallGlobalPackages(runner).map((record) => record.status)).toEqual([
      "absent",
      "absent",
      "absent",
      "absent",
    ]);
  });
});
