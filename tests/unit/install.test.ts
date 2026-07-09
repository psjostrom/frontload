import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { hookDefinitions } from "../../src/hooks/definitions.js";
import { buildMcpEntry, detectPackageManager, globalInstallCommand, initAll, initProject, installGlobalFrontload, isGloballyInstalled, parseAgents, parseConfigScope, upgradeAll, upgradeGlobalFrontload } from "../../src/install/install.js";
import { stateExcludeStatus } from "../../src/utils/path.js";

function writeExecutable(dir: string, name = "frontload"): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

describe("installer", () => {
  it("initializes project files and onboarded state", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-"));
    const result = initProject(repo);
    expect(result.map((write) => path.relative(repo, write.path))).toEqual([
      "frontload.config.json",
      ".frontload"
    ]);
    expect(fs.existsSync(path.join(repo, "frontload.config.json"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".frontload"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "codex/config.toml"))).toBe(false);
  });

  it("adds generated state to local git exclude during init", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-git-"));
    await execa("git", ["init"], { cwd: repo });

    initProject(repo);

    expect(fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf8")).toContain(".frontload/");
  });

  it("does not trust arbitrary .git file targets during init", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-malformed-git-"));
    const repo = path.join(parent, "repo");
    const outside = path.join(parent, "outside-git");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, ".git"), "gitdir: ../outside-git\n");

    initProject(repo);

    expect(fs.existsSync(path.join(outside, "info", "exclude"))).toBe(false);
  });

  it("keeps generated state ignored in linked worktrees", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-worktree-"));
    const repo = path.join(parent, "repo");
    const worktree = path.join(parent, "worktree");
    await execa("git", ["init", repo]);
    fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
    await execa("git", ["add", "."], { cwd: repo });
    await execa("git", ["commit", "-m", "init"], {
      cwd: repo,
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" }
    });
    await execa("git", ["worktree", "add", "-b", "worktree-branch", worktree], { cwd: repo });

    initProject(worktree);
    const status = await execa("git", ["status", "--short"], { cwd: worktree });

    expect(status.stdout).toBe("?? frontload.config.json");
    expect(stateExcludeStatus(worktree)).toMatchObject({ ignored: true });
  });

  it("configures Codex MCP from init", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-codex-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-codex-"));
    const result = initAll(repo, ["codex"], home);
    const codexConfigFile = path.join(repo, ".codex/config.toml");
    const codexConfig = fs.readFileSync(codexConfigFile, "utf8");

    expect(result.agents.map((agent) => agent.agent)).toEqual(["codex"]);
    expect(result.agents[0].writes.map((write) => path.relative(repo, write.path))).toEqual([
      ".codex/config.toml",
      path.relative(repo, path.join(home, ".codex/hooks.json")),
      path.relative(repo, path.join(home, ".codex/skills/frontload"))
    ]);
    expect(codexConfig).toMatch(/^\[mcp_servers\.frontload_[^\]]+\]$/m);
    expect(codexConfig).toContain('command = "frontload"');
    expect(codexConfig).toContain(`args = ["mcp", "--repo", "${repo}"]`);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".codex/hooks.json"), "utf8")).hooks).toEqual({
      PreToolUse: [
        {
          matcher: "^Bash$",
          hooks: [
            {
              type: "command",
              command: hookDefinitions.codex[0].hook.command,
              timeout: 10,
              statusMessage: "Applying Frontload budget policy"
            }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: "^Bash$",
          hooks: [
            {
              type: "command",
              command: hookDefinitions.codex[1].hook.command,
              timeout: 10,
              statusMessage: "Bounding Frontload command output"
            }
          ]
        }
      ]
    });
    expect(fs.existsSync(path.join(home, ".codex/skills/frontload/SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(home, ".codex/skills/frontload/SKILL.md"), "utf8")).toBe(
      fs.readFileSync(path.resolve("plugins/codex/skills/frontload/SKILL.md"), "utf8")
    );
    expect(fs.existsSync(path.join(home, "plugins/frontload/.codex-plugin/plugin.json"))).toBe(false);
  });

  it("configures two Codex repos without overwriting either MCP repo", () => {
    const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-codex-a-"));
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-codex-b-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-codex-multi-"));

    initAll(repoA, ["codex"], home);
    initAll(repoB, ["codex"], home);

    const configA = fs.readFileSync(path.join(repoA, ".codex/config.toml"), "utf8");
    const configB = fs.readFileSync(path.join(repoB, ".codex/config.toml"), "utf8");
    const hooks = JSON.parse(fs.readFileSync(path.join(home, ".codex/hooks.json"), "utf8"));

    expect(configA).toContain(`args = ["mcp", "--repo", "${repoA}"]`);
    expect(configB).toContain(`args = ["mcp", "--repo", "${repoB}"]`);
    expect(fs.existsSync(path.join(home, ".codex/config.toml"))).toBe(false);
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe(hookDefinitions.codex[0].hook.command);
  });

  it("uses distinct Codex MCP server names for distinct project repos", () => {
    const parentA = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-codex-a-"));
    const parentB = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-codex-b-"));
    const repoA = path.join(parentA, "app");
    const repoB = path.join(parentB, "app");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-codex-multi-"));
    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);

    initAll(repoA, ["codex"], home);
    initAll(repoB, ["codex"], home);

    const configA = fs.readFileSync(path.join(repoA, ".codex/config.toml"), "utf8");
    const configB = fs.readFileSync(path.join(repoB, ".codex/config.toml"), "utf8");
    const serverA = configA.match(/^\[mcp_servers\.([^\]]+)\]$/m)?.[1];
    const serverB = configB.match(/^\[mcp_servers\.([^\]]+)\]$/m)?.[1];

    expect(serverA).toMatch(/^frontload_/);
    expect(serverB).toMatch(/^frontload_/);
    expect(serverA).not.toBe(serverB);
    expect(configA).toContain(`args = ["mcp", "--repo", "${repoA}"]`);
    expect(configB).toContain(`args = ["mcp", "--repo", "${repoB}"]`);
  });

  it("configures all supported agent adapters from init", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-all-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-all-"));
    const result = initAll(repo, ["all"], home);
    const claudeConfig = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8"));

    expect(result.agents.map((agent) => agent.agent)).toEqual(["codex", "claude"]);
    expect(fs.existsSync(path.join(repo, ".codex/config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".codex/config.toml"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".codex/skills/frontload/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude/skills/frontload/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".claude/settings.json"))).toBe(true);
    expect(claudeConfig.mcpServers.frontload).toEqual({
      type: "stdio",
      command: "frontload",
      args: ["mcp", "--repo", repo]
    });
    expect(JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8")).hooks).toEqual({
      PreToolUse: [
        {
          matcher: "Read|Bash",
          hooks: [
            {
              type: "command",
              command: "frontload",
              args: ["hook", "pre-tool-use", "--host", "claude"],
              timeout: 10
            }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: "Grep|Glob",
          hooks: [
            {
              type: "command",
              command: "frontload",
              args: ["hook", "post-tool-use", "--host", "claude"],
              timeout: 10
            }
          ]
        }
      ]
    });
  });

  it("can configure Claude Code globally", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-claude-global-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-claude-global-"));
    initAll(repo, ["claude"], home, false, "global");
    const claudeConfig = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));

    expect(claudeConfig.mcpServers.frontload).toEqual({
      type: "stdio",
      command: "frontload",
      args: ["mcp", "--repo", repo]
    });
    expect(fs.existsSync(path.join(home, ".claude/skills/frontload/SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(home, ".claude/skills/frontload/SKILL.md"), "utf8")).toBe(
      fs.readFileSync(path.resolve("plugins/claude/skills/frontload/SKILL.md"), "utf8")
    );
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].args).toEqual(["hook", "pre-tool-use", "--host", "claude"]);
    expect(settings.hooks.PostToolUse[0].hooks[0].args).toEqual(["hook", "post-tool-use", "--host", "claude"]);
    expect(fs.existsSync(path.join(repo, ".mcp.json"))).toBe(false);
  });

  it("preserves existing Claude MCP servers and hooks", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-merge-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-merge-"));
    fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { existing: { command: "other" } } }, null, 2));
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude/settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "other-hook" }]
          },
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "frontload", args: ["hook", "pre-tool-use"], timeout: 3 }]
          }
        ],
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "post-hook" }]
          },
          {
            matcher: "Glob",
            hooks: [{ type: "command", command: "frontload", args: ["hook", "post-tool-use"], timeout: 3 }]
          }
        ]
      }
    }, null, 2));
    initAll(repo, ["claude"], home);
    const claudeConfig = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8"));
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8"));

    expect(claudeConfig.mcpServers.existing).toEqual({ command: "other" });
    expect(claudeConfig.mcpServers.frontload.command).toBe("frontload");
    expect(claudeSettings.hooks.PostToolUse).toHaveLength(2);
    expect(claudeSettings.hooks.PostToolUse[0].hooks[0].command).toBe("post-hook");
    expect(claudeSettings.hooks.PostToolUse[1]).toEqual({
      matcher: "Grep|Glob",
      hooks: [
        {
          type: "command",
          command: "frontload",
          args: ["hook", "post-tool-use", "--host", "claude"],
          timeout: 10
        }
      ]
    });
    expect(claudeSettings.hooks.PreToolUse).toHaveLength(2);
    expect(claudeSettings.hooks.PreToolUse[0].hooks[0].command).toBe("other-hook");
    expect(claudeSettings.hooks.PreToolUse[1]).toEqual({
      matcher: "Read|Bash",
      hooks: [
        {
          type: "command",
          command: "frontload",
          args: ["hook", "pre-tool-use", "--host", "claude"],
          timeout: 10
        }
      ]
    });
  });

  it("replaces stale Codex frontload tables without touching other servers", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-codex-merge-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-codex-merge-"));
    const configFile = path.join(repo, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, [
      "[mcp_servers.other]",
      "command = \"other\"",
      "",
      "[mcp_servers.frontload]",
      "command = \"old-frontload\"",
      "",
      "[mcp_servers.frontload.env]",
      "OLD = \"1\"",
      ""
    ].join("\n"));
    initAll(repo, ["codex"], home);
    const codexConfig = fs.readFileSync(configFile, "utf8");

    expect(codexConfig).toContain("[mcp_servers.other]");
    expect(codexConfig).toContain('command = "frontload"');
    expect(codexConfig).not.toContain("old-frontload");
    expect(codexConfig).not.toContain("[mcp_servers.frontload.env]");
  });

  it("preserves unrelated Codex frontload-prefixed servers", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-codex-prefix-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-codex-prefix-"));
    const configFile = path.join(repo, ".codex/config.toml");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, [
      "[mcp_servers.frontload_proxy]",
      "command = \"proxy\"",
      "args = [\"serve\"]",
      "",
      "[mcp_servers.frontload]",
      "command = \"old-frontload\"",
      "",
      "[mcp_servers.other]",
      "command = \"other\"",
      ""
    ].join("\n"));

    initAll(repo, ["codex"], home);
    const codexConfig = fs.readFileSync(configFile, "utf8");

    expect(codexConfig).toContain("[mcp_servers.frontload_proxy]");
    expect(codexConfig).toContain('command = "proxy"');
    expect(codexConfig).toContain("[mcp_servers.other]");
    expect(codexConfig).toContain('command = "frontload"');
    expect(codexConfig).not.toContain("old-frontload");
  });

  it("preserves unrelated Codex hooks and replaces stale Frontload hooks", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-init-codex-hooks-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-codex-hooks-"));
    const hooksFile = path.join(home, ".codex/hooks.json");
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "^apply_patch$",
            hooks: [{ type: "command", command: "other-pre-hook" }]
          },
          {
            matcher: "^Bash$",
            hooks: [{ type: "command", command: "frontload hook pre-tool-use", timeout: 3 }]
          }
        ],
        PostToolUse: [
          {
            matcher: "^Bash$",
            hooks: [
              { type: "command", command: "other-post-hook" },
              { type: "command", command: "frontload hook post-tool-use", timeout: 3 }
            ]
          }
        ]
      }
    }, null, 2));

    const result = initAll(repo, ["codex"], home);
    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8")).hooks;

    expect(result.agents[0].notes.join(" ")).toContain("/hooks");
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0].hooks).toEqual([{ type: "command", command: "other-pre-hook" }]);
    expect(hooks.PreToolUse[1].hooks[0].command).toBe(hookDefinitions.codex[0].hook.command);
    expect(hooks.PostToolUse).toHaveLength(2);
    expect(hooks.PostToolUse[0].hooks).toEqual([{ type: "command", command: "other-post-hook" }]);
    expect(hooks.PostToolUse[1].hooks[0].command).toBe(hookDefinitions.codex[1].hook.command);
  });

  it("parses agent lists", () => {
    expect(parseAgents("codex,claude")).toEqual(["codex", "claude"]);
    expect(parseAgents("codex,codex")).toEqual(["codex"]);
    expect(parseAgents("all,codex")).toEqual(["all"]);
    expect(parseAgents("none")).toEqual([]);
    expect(() => parseAgents("cursor")).toThrow("Unknown agent");
  });

  it("builds the portable MCP entry", () => {
    expect(buildMcpEntry()).toEqual({ command: "frontload", args: ["mcp", "--repo", "."] });
  });

  it("parses config scope and package managers", () => {
    expect(parseConfigScope(undefined)).toBe("project");
    expect(parseConfigScope("global")).toBe("global");
    expect(() => parseConfigScope("workspace")).toThrow("Unknown config scope");
    expect(detectPackageManager("pnpm/10.14.0 npm/? node/?")).toBe("pnpm");
    expect(globalInstallCommand()).toEqual({ packageManager: "npm", command: "npm", args: ["install", "-g", "frontload"] });
    expect(globalInstallCommand("bun")).toEqual({ packageManager: "bun", command: "bun", args: ["add", "-g", "frontload"] });
  });

  it("looks past temporary npx shims when checking for global installs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-path-"));
    const npxBin = path.join(tmp, "_npx/123/bin");
    const localBin = path.join(tmp, "repo/node_modules/.bin");
    const globalBin = path.join(tmp, "global/bin");
    writeExecutable(npxBin);
    writeExecutable(localBin);
    writeExecutable(globalBin);

    expect(isGloballyInstalled("frontload", npxBin)).toBe(false);
    expect(isGloballyInstalled("frontload", `${npxBin}${path.delimiter}${localBin}`)).toBe(false);
    expect(isGloballyInstalled("frontload", `${npxBin}${path.delimiter}${localBin}${path.delimiter}${globalBin}`)).toBe(true);
  });

  it("verifies frontload is on PATH after global install", () => {
    const oldPath = process.env.PATH;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-global-bin-"));
    process.env.PATH = bin;
    try {
      const installed = installGlobalFrontload("npm", () => {
        writeExecutable(bin);
      });
      expect(installed.action).toBe("installed");

      fs.rmSync(path.join(bin, "frontload"), { force: true });
      const unresolved = installGlobalFrontload("npm", () => undefined);
      expect(unresolved.action).toBe("manual");
      expect(unresolved.error).toContain("not found on PATH");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("upgrades the global package to the latest tag", () => {
    const oldPath = process.env.PATH;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-global-upgrade-bin-"));
    process.env.PATH = bin;
    writeExecutable(bin);
    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const upgraded = upgradeGlobalFrontload("npm", (command, args) => {
        calls.push({ command, args });
      });

      expect(upgraded.action).toBe("updated");
      expect(calls).toEqual([{ command: "npm", args: ["install", "-g", "frontload@latest"] }]);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("skips upgrade when already at the latest version", () => {
    const oldPath = process.env.PATH;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-global-upgrade-current-bin-"));
    process.env.PATH = bin;
    writeExecutable(bin);
    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const upgraded = upgradeGlobalFrontload("npm", (command, args) => {
        calls.push({ command, args });
      }, () => "0.2.2");

      expect(upgraded.action).toBe("skipped");
      expect(upgraded.notes[0]).toContain("Already at the latest version (0.2.2)");
      expect(calls).toEqual([]);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("proceeds with upgrade when version check fails", () => {
    const oldPath = process.env.PATH;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-global-upgrade-version-fail-bin-"));
    process.env.PATH = bin;
    writeExecutable(bin);
    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const upgraded = upgradeGlobalFrontload("npm", (command, args) => {
        calls.push({ command, args });
      }, () => undefined);

      expect(upgraded.action).toBe("updated");
      expect(calls).toEqual([{ command: "npm", args: ["install", "-g", "frontload@latest"] }]);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("upgrades only existing Codex configuration and refreshes managed skills", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-codex-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-codex-"));
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({ custom: true }));
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "custom agents\n");
    const codexConfigFile = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
    const configuredRepo = path.join(repo, "configured-repo");
    fs.writeFileSync(codexConfigFile, [
      "[mcp_servers.frontload]",
      "command = \"old-frontload\"",
      `args = ["mcp", "--repo", "${configuredRepo}"]`,
      "",
      "[mcp_servers.other]",
      "command = \"other\"",
      ""
    ].join("\n"));
    const skillFile = path.join(home, ".codex/skills/frontload/SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "old skill\n");
    fs.mkdirSync(configuredRepo);
    fs.writeFileSync(path.join(configuredRepo, "frontload.config.json"), "{}");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

    const result = upgradeAll(repo, home);
    const codexConfig = fs.readFileSync(codexConfigFile, "utf8");

    expect(result.project).toEqual([]);
    expect(result.agents.map((agent) => agent.agent)).toEqual(["codex"]);
    expect(result.agents[0].notes[0]).toContain("legacy global ~/.codex/config.toml");
    expect(codexConfig).toContain("[mcp_servers.other]");
    expect(codexConfig).toContain('command = "frontload"');
    expect(codexConfig).toContain(`args = ["mcp", "--repo", "${configuredRepo}"]`);
    expect(codexConfig).not.toContain("old-frontload");
    expect(fs.readFileSync(skillFile, "utf8")).toBe(
      fs.readFileSync(path.resolve("plugins/codex/skills/frontload/SKILL.md"), "utf8")
    );
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude/skills/frontload/SKILL.md"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "frontload.config.json"), "utf8")).toBe(JSON.stringify({ custom: true }));
    expect(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toBe("custom agents\n");
  });

  it("repins stale absolute Codex repo args to the current repo during upgrade", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-stale-codex-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-stale-codex-"));
    const codexConfigFile = path.join(home, ".codex/config.toml");
    const staleRepo = path.join(os.tmpdir(), "frontload-missing-worktree");
    fs.rmSync(staleRepo, { recursive: true, force: true });
    fs.mkdirSync(path.join(staleRepo, ".frontload"), { recursive: true });
    fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
    fs.writeFileSync(codexConfigFile, [
      "[mcp_servers.frontload]",
      "command = \"frontload\"",
      `args = ["mcp", "--repo", "${staleRepo}"]`,
      ""
    ].join("\n"));

    upgradeAll(repo, home);
    const codexConfig = fs.readFileSync(codexConfigFile, "utf8");

    expect(codexConfig).toContain(`args = ["mcp", "--repo", "${repo}"]`);
    expect(codexConfig).not.toContain(staleRepo);
  });

  it("preserves existing absolute Codex repo args without Frontload marker files during upgrade", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-current-codex-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-plain-codex-"));
    const codexConfigFile = path.join(home, ".codex/config.toml");
    const plainRepo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-plain-target-"));
    fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
    fs.writeFileSync(codexConfigFile, [
      "[mcp_servers.frontload]",
      "command = \"frontload\"",
      `args = ["mcp", "--repo", "${plainRepo}"]`,
      ""
    ].join("\n"));

    upgradeAll(repo, home);
    const codexConfig = fs.readFileSync(codexConfigFile, "utf8");

    expect(codexConfig).toContain(`args = ["mcp", "--repo", "${plainRepo}"]`);
    expect(codexConfig).not.toContain(`args = ["mcp", "--repo", "${repo}"]`);
  });

  it("refreshes existing project-local Codex configuration during upgrade", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-project-codex-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-project-codex-"));
    const codexConfigFile = path.join(repo, ".codex/config.toml");
    fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
    fs.writeFileSync(codexConfigFile, [
      "[mcp_servers.frontload]",
      "command = \"old-frontload\"",
      "args = [\"mcp\", \"--repo\", \".\"]",
      "",
      "[mcp_servers.other]",
      "command = \"other\"",
      ""
    ].join("\n"));

    const result = upgradeAll(repo, home);
    const codexConfig = fs.readFileSync(codexConfigFile, "utf8");

    expect(result.agents.map((agent) => agent.agent)).toEqual(["codex"]);
    expect(result.agents[0].notes[0]).toContain("project .codex/config.toml");
    expect(codexConfig).toContain("[mcp_servers.other]");
    expect(codexConfig).toContain('command = "frontload"');
    expect(codexConfig).toContain(`args = ["mcp", "--repo", "${repo}"]`);
    expect(fs.existsSync(path.join(home, ".codex/config.toml"))).toBe(false);
  });

  it("refreshes legacy dot repo args to the current repo during upgrade", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-dot-repo-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-dot-repo-"));
    const codexConfigFile = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
    fs.writeFileSync(codexConfigFile, [
      "[mcp_servers.frontload]",
      "command = \"frontload\"",
      "args = [\"mcp\", \"--repo\", \".\"]",
      ""
    ].join("\n"));

    upgradeAll(repo, home);
    const codexConfig = fs.readFileSync(codexConfigFile, "utf8");

    expect(codexConfig).toContain(`args = ["mcp", "--repo", "${repo}"]`);
  });

  it("pins relative Codex repo args against the current repo during upgrade", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-relative-repo-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-relative-repo-"));
    const codexConfigFile = path.join(home, ".codex/config.toml");
    fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true });
    fs.writeFileSync(codexConfigFile, [
      "[mcp_servers.frontload]",
      "command = \"frontload\"",
      "args = [\"mcp\", \"--repo\", \"packages/app\"]",
      ""
    ].join("\n"));

    upgradeAll(repo, home);
    const codexConfig = fs.readFileSync(codexConfigFile, "utf8");

    expect(codexConfig).toContain(`args = ["mcp", "--repo", "${path.join(repo, "packages/app")}"]`);
  });

  it("refreshes legacy dot repo args for Claude project and global configs", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-claude-dot-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-claude-dot-"));
    fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({
      mcpServers: {
        frontload: {
          type: "stdio",
          command: "old-frontload",
          args: ["mcp", "--repo", "."]
        }
      }
    }, null, 2));
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        frontload: {
          type: "stdio",
          command: "old-frontload",
          args: ["mcp", "--repo", "."]
        }
      }
    }, null, 2));

    upgradeAll(repo, home);
    const projectConfig = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8"));
    const globalConfig = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));

    expect(projectConfig.mcpServers.frontload.args).toEqual(["mcp", "--repo", repo]);
    expect(globalConfig.mcpServers.frontload.args).toEqual(["mcp", "--repo", repo]);
  });

  it("repins stale absolute Claude repo args to the current repo during upgrade", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-stale-claude-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-stale-claude-"));
    const staleRepo = path.join(os.tmpdir(), "frontload-missing-claude-worktree");
    fs.rmSync(staleRepo, { recursive: true, force: true });
    fs.mkdirSync(path.join(staleRepo, ".frontload"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({
      mcpServers: {
        frontload: {
          type: "stdio",
          command: "frontload",
          args: ["mcp", "--repo", staleRepo]
        }
      }
    }, null, 2));
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

    upgradeAll(repo, home);
    const claudeConfig = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8"));

    expect(claudeConfig.mcpServers.frontload.args).toEqual(["mcp", "--repo", repo]);
  });

  it("upgrades existing Claude project configuration without creating new project scaffolding", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-claude-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-claude-"));
    fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { frontload: { command: "old-frontload" } } }, null, 2));
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude/settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "frontload", args: ["hook", "pre-tool-use"], timeout: 3 }]
          }
        ]
      }
    }, null, 2));
    const skillFile = path.join(home, ".claude/skills/frontload/SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "old skill\n");

    const result = upgradeAll(repo, home);
    const claudeConfig = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8"));
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8"));

    expect(result.project).toEqual([]);
    expect(result.agents.map((agent) => agent.agent)).toEqual(["claude"]);
    expect(claudeConfig.mcpServers.frontload).toEqual({
      type: "stdio",
      command: "frontload",
      args: ["mcp", "--repo", repo]
    });
    expect(claudeSettings.hooks.PreToolUse[0].matcher).toBe("Read|Bash");
    expect(claudeSettings.hooks.PostToolUse).toBeUndefined();
    expect(fs.readFileSync(skillFile, "utf8")).toBe(
      fs.readFileSync(path.resolve("plugins/claude/skills/frontload/SKILL.md"), "utf8")
    );
    expect(fs.existsSync(path.join(repo, "frontload.config.json"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".frontload"))).toBe(false);
  });

  it("upgrades existing Claude global configuration without creating project-local Claude config", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-upgrade-claude-global-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-home-upgrade-claude-global-"));
    const configuredRepo = path.join(repo, "configured-global-repo");
    fs.mkdirSync(configuredRepo);
    fs.writeFileSync(path.join(configuredRepo, "frontload.config.json"), "{}");
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        frontload: {
          type: "stdio",
          command: "old-frontload",
          args: ["mcp", "--repo", configuredRepo]
        }
      }
    }, null, 2));
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Glob",
            hooks: [{ type: "command", command: "frontload", args: ["hook", "post-tool-use"], timeout: 3 }]
          }
        ]
      }
    }, null, 2));
    const skillFile = path.join(home, ".claude/skills/frontload/SKILL.md");
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, "old skill\n");

    const result = upgradeAll(repo, home);
    const claudeConfig = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));

    expect(result.project).toEqual([]);
    expect(result.agents.map((agent) => agent.agent)).toEqual(["claude"]);
    expect(claudeConfig.mcpServers.frontload).toEqual({
      type: "stdio",
      command: "frontload",
      args: ["mcp", "--repo", configuredRepo]
    });
    expect(claudeSettings.hooks.PreToolUse).toBeUndefined();
    expect(claudeSettings.hooks.PostToolUse[0].matcher).toBe("Grep|Glob");
    expect(fs.readFileSync(skillFile, "utf8")).toBe(
      fs.readFileSync(path.resolve("plugins/claude/skills/frontload/SKILL.md"), "utf8")
    );
    expect(fs.existsSync(path.join(repo, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".claude/settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "frontload.config.json"))).toBe(false);
  });
});
