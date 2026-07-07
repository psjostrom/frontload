import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { readEvents } from "../../src/budget/events.js";
import { parseHookHost, runPostToolUseHook, runPreToolUseHook } from "../../src/gate/entry.js";
import { hookDefinitions } from "../../src/hooks/definitions.js";

function initializedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-hook-entry-"));
  fs.mkdirSync(path.join(repo, ".frontload"));
  return repo;
}

function writeFakeFrontload(binDir: string): string {
  const marker = path.join(binDir, "frontload-invoked.log");
  const frontload = path.join(binDir, "frontload");
  fs.writeFileSync(frontload, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FRONTLOAD_HOOK_MARKER\"\n");
  fs.chmodSync(frontload, 0o755);
  return marker;
}

describe("hook entry adapters", () => {
  it("parses supported hook hosts", () => {
    expect(parseHookHost("claude")).toBe("claude");
    expect(parseHookHost("codex")).toBe("codex");
    expect(() => parseHookHost("cursor")).toThrow("Unknown hook host");
  });

  it("uses the shared PreToolUse rewrite for both hosts", async () => {
    const repo = initializedRepo();
    const payload = JSON.stringify({
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "pnpm test" }
    });

    for (const host of ["claude", "codex"] as const) {
      const result = JSON.parse((await runPreToolUseHook(host, payload))!);
      expect(result.hookSpecificOutput).toMatchObject({
        hookEventName: "PreToolUse",
        permissionDecision: "allow"
      });
      expect(result.hookSpecificOutput.updatedInput.command).toContain("run");
      expect(result.hookSpecificOutput.updatedInput.command).toContain("--kind test");
    }
  });

  it("emits shape-preserving Claude PostToolUse output", async () => {
    const repo = initializedRepo();
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: { maxToolOutputChars: 500 }
    }));
    const toolResponse = {
      filenames: Array.from({ length: 100 }, (_, i) => `src/very/long/path/file-${i}.ts`),
      durationMs: 12,
      numFiles: 100,
      truncated: false
    };
    const payload = JSON.stringify({
      cwd: repo,
      tool_name: "Glob",
      tool_response: toolResponse
    });

    const result = JSON.parse((await runPostToolUseHook("claude", payload))!);
    expect(result.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(result.hookSpecificOutput.updatedToolOutput).toMatchObject({
      durationMs: 12,
      numFiles: 100,
      truncated: true
    });
    expect(JSON.stringify(result.hookSpecificOutput.updatedToolOutput).length).toBeLessThanOrEqual(500);
    const event = readEvents(repo).at(-1);
    expect(event).toMatchObject({
      source: "hook",
      operation: "post-tool-use:Glob",
      baselineBytes: Buffer.byteLength(JSON.stringify(toolResponse)),
      baselineKind: "observed-tool-output",
      outputBytes: Buffer.byteLength(JSON.stringify(result.hookSpecificOutput.updatedToolOutput))
    });
    expect(event!.netSavedBytes).toBeGreaterThan(0);
  });

  it("compacts Claude Grep content without changing scalar metadata", async () => {
    const repo = initializedRepo();
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: { maxToolOutputChars: 180 }
    }));
    const payload = JSON.stringify({
      cwd: repo,
      tool_name: "Grep",
      tool_response: {
        mode: "content",
        numFiles: 3,
        numMatches: 100,
        content: "match\n".repeat(100),
        truncated: false
      }
    });

    const result = JSON.parse((await runPostToolUseHook("claude", payload))!);
    expect(result.hookSpecificOutput.updatedToolOutput).toMatchObject({
      mode: "content",
      numFiles: 3,
      numMatches: 100,
      truncated: true
    });
    expect(JSON.stringify(result.hookSpecificOutput.updatedToolOutput).length).toBeLessThanOrEqual(180);
  });

  it("replaces oversized Codex Bash output", async () => {
    const repo = initializedRepo();
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: { maxToolOutputChars: 500 }
    }));
    const payload = JSON.stringify({
      cwd: repo,
      tool_name: "Bash",
      tool_response: "x".repeat(2000)
    });

    const result = JSON.parse((await runPostToolUseHook("codex", payload))!);
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("[Frontload truncated ");
    expect(result.reason.length).toBeLessThanOrEqual(500);
    expect(readEvents(repo).at(-1)).toMatchObject({
      source: "hook",
      operation: "post-tool-use:Bash",
      baselineKind: "observed-tool-output"
    });
  });

  it("does not emit post-hook output when no compaction is needed", async () => {
    const repo = initializedRepo();
    const payload = JSON.stringify({
      cwd: repo,
      tool_name: "Bash",
      tool_response: "short output"
    });

    expect(await runPostToolUseHook("codex", payload)).toBeNull();
    expect(readEvents(repo).at(-1)).toMatchObject({
      baselineKind: "observed-tool-output",
      netSavedBytes: 0
    });
  });

  it("stays inert outside initialized repositories and fails open", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-hook-uninitialized-"));
    const payload = JSON.stringify({
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: "x".repeat(10000)
    });

    expect(await runPreToolUseHook("claude", payload)).toBeNull();
    expect(await runPostToolUseHook("codex", payload)).toBeNull();
    expect(await runPreToolUseHook("claude", "{not json")).toBeNull();
    expect(await runPostToolUseHook("claude", "{not json")).toBeNull();
  });

  it("does not invoke the configured Codex global hook command outside initialized repositories", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-hook-global-uninitialized-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-hook-bin-"));
    const marker = writeFakeFrontload(binDir);
    const env = {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CODEX_PROJECT_DIR: repo,
      FRONTLOAD_HOOK_MARKER: marker
    };

    for (const definition of hookDefinitions.codex) {
      await execa("sh", ["-c", definition.hook.command], {
        cwd: repo,
        env,
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: "output" })
      });
    }

    expect(fs.existsSync(marker)).toBe(false);
  });

  it("invokes the configured Codex global hook command inside initialized repositories", async () => {
    const repo = initializedRepo();
    const nested = path.join(repo, "src/nested");
    fs.mkdirSync(nested, { recursive: true });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-hook-bin-"));
    const marker = writeFakeFrontload(binDir);
    const env = {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CODEX_PROJECT_DIR: nested,
      FRONTLOAD_HOOK_MARKER: marker
    };

    for (const definition of hookDefinitions.codex) {
      await execa("sh", ["-c", definition.hook.command], {
        cwd: nested,
        env,
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: "output" })
      });
    }

    expect(fs.readFileSync(marker, "utf8").split("\n").filter(Boolean)).toEqual([
      "hook pre-tool-use --host codex",
      "hook post-tool-use --host codex"
    ]);
  });

  it("finds an initialized repository from a nested working directory", async () => {
    const repo = initializedRepo();
    const nested = path.join(repo, "src/nested");
    fs.mkdirSync(nested, { recursive: true });
    const payload = JSON.stringify({
      cwd: nested,
      tool_name: "Bash",
      tool_input: { command: "pnpm test" }
    });

    expect(await runPreToolUseHook("claude", payload)).not.toBeNull();
  });

  it("uses only the selected host project directory when host environments conflict", async () => {
    const claudeRepo = initializedRepo();
    const codexRepo = initializedRepo();
    const previousClaude = process.env.CLAUDE_PROJECT_DIR;
    const previousCodex = process.env.CODEX_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = claudeRepo;
    process.env.CODEX_PROJECT_DIR = codexRepo;

    try {
      const payload = JSON.stringify({
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "frontload-hook-payload-cwd-")),
        tool_name: "Bash",
        tool_input: { command: "pnpm test" }
      });
      const claude = JSON.parse((await runPreToolUseHook("claude", payload))!);
      const codex = JSON.parse((await runPreToolUseHook("codex", payload))!);

      expect(claude.hookSpecificOutput.updatedInput.command).toContain(claudeRepo);
      expect(claude.hookSpecificOutput.updatedInput.command).not.toContain(codexRepo);
      expect(codex.hookSpecificOutput.updatedInput.command).toContain(codexRepo);
      expect(codex.hookSpecificOutput.updatedInput.command).not.toContain(claudeRepo);
    } finally {
      if (previousClaude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousClaude;
      if (previousCodex === undefined) delete process.env.CODEX_PROJECT_DIR;
      else process.env.CODEX_PROJECT_DIR = previousCodex;
    }
  });

  it("uses the tool cwd before host project directory when rewriting commands", async () => {
    const toolRepo = initializedRepo();
    const codexRepo = initializedRepo();
    const previousCodex = process.env.CODEX_PROJECT_DIR;
    process.env.CODEX_PROJECT_DIR = codexRepo;

    try {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "pnpm test", workdir: toolRepo }
      });
      const codex = JSON.parse((await runPreToolUseHook("codex", payload))!);

      expect(codex.hookSpecificOutput.updatedInput.command).toContain(toolRepo);
      expect(codex.hookSpecificOutput.updatedInput.command).not.toContain(codexRepo);
    } finally {
      if (previousCodex === undefined) delete process.env.CODEX_PROJECT_DIR;
      else process.env.CODEX_PROJECT_DIR = previousCodex;
    }
  });

  it("uses the hook process cwd before host project directory when no tool cwd is provided", async () => {
    const toolRepo = initializedRepo();
    const codexRepo = initializedRepo();
    const previousCodex = process.env.CODEX_PROJECT_DIR;
    const previousCwd = process.cwd();
    process.env.CODEX_PROJECT_DIR = codexRepo;
    process.chdir(toolRepo);

    try {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "pnpm test" }
      });
      const codex = JSON.parse((await runPreToolUseHook("codex", payload))!);

      expect(codex.hookSpecificOutput.updatedInput.command).toContain(toolRepo);
      expect(codex.hookSpecificOutput.updatedInput.command).not.toContain(codexRepo);
    } finally {
      process.chdir(previousCwd);
      if (previousCodex === undefined) delete process.env.CODEX_PROJECT_DIR;
      else process.env.CODEX_PROJECT_DIR = previousCodex;
    }
  });

  it("does not emit an invalid replacement when structured output cannot fit", async () => {
    const repo = initializedRepo();
    fs.writeFileSync(path.join(repo, "frontload.config.json"), JSON.stringify({
      budgets: { maxToolOutputChars: 64 }
    }));
    const payload = JSON.stringify({
      cwd: repo,
      tool_name: "Glob",
      tool_response: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`flag${i}`, false]))
    });

    expect(await runPostToolUseHook("claude", payload)).toBeNull();
    expect(readEvents(repo).at(-1)).toMatchObject({
      operation: "post-tool-use:Glob",
      baselineKind: "observed-tool-output",
      netSavedBytes: 0
    });
  });
});
