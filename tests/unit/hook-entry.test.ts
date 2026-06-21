import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseHookHost, runPostToolUseHook, runPreToolUseHook } from "../../src/gate/entry.js";

function initializedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-hook-entry-"));
  fs.mkdirSync(path.join(repo, ".frontload"));
  return repo;
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
    const payload = JSON.stringify({
      cwd: repo,
      tool_name: "Glob",
      tool_response: {
        filenames: Array.from({ length: 100 }, (_, i) => `src/very/long/path/file-${i}.ts`),
        durationMs: 12,
        numFiles: 100,
        truncated: false
      }
    });

    const result = JSON.parse((await runPostToolUseHook("claude", payload))!);
    expect(result.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(result.hookSpecificOutput.updatedToolOutput).toMatchObject({
      durationMs: 12,
      numFiles: 100,
      truncated: true
    });
    expect(JSON.stringify(result.hookSpecificOutput.updatedToolOutput).length).toBeLessThanOrEqual(500);
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
  });

  it("does not emit post-hook output when no compaction is needed", async () => {
    const repo = initializedRepo();
    const payload = JSON.stringify({
      cwd: repo,
      tool_name: "Bash",
      tool_response: "short output"
    });

    expect(await runPostToolUseHook("codex", payload)).toBeNull();
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
  });
});
