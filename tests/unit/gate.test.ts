import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/config.js";
import { compactToolOutput, evaluate } from "../../src/gate/gate.js";

describe("PreToolUse gate", () => {
  it("rewrites simple test commands through frontload run", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "pnpm test", description: "run tests" } }, defaultConfig);
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput).toEqual({
      command: "frontload run --kind test -- pnpm test",
      description: "run tests"
    });
  });

  it("uses a configured runner command when rewriting", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "pnpm lint" } }, defaultConfig, {
      runnerCommand: "node dist/src/cli/index.js run --repo /tmp/repo"
    });
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("node dist/src/cli/index.js run --repo /tmp/repo --kind lint -- pnpm lint");
  });

  it("rewrites typecheck commands", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "npx tsc --noEmit" } }, defaultConfig);
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("frontload run --kind typecheck -- npx tsc --noEmit");
  });

  it("does not rewrite already budgeted commands", () => {
    expect(evaluate({ tool_name: "Bash", tool_input: { command: "frontload run --kind test -- pnpm test" } }, defaultConfig)).toBeNull();
  });

  it("does not rewrite compound shell commands", () => {
    expect(evaluate({ tool_name: "Bash", tool_input: { command: "pnpm test && pnpm lint" } }, defaultConfig)).toBeNull();
  });

  it("rewrites broad shell dumps through cheaper Frontload commands", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "find ." } }, defaultConfig);
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("frontload search '.' --limit 50");
  });

  it("rewrites whole-repo rg file inventories through the configured search command", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "rg --files" } }, defaultConfig, {
      searchCommand: "node dist/src/cli/index.js search --repo /tmp/repo"
    });
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("node dist/src/cli/index.js search --repo /tmp/repo '.' --limit 50");
  });

  it("rewrites simple literal rg searches through Frontload search", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "rg -F \"stale tooltip\" ." } }, defaultConfig);
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("frontload search 'stale tooltip' --limit 20");
  });

  it("rewrites whole-repo fd inventories through Frontload search", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "fd" } }, defaultConfig);
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("frontload search '.' --limit 50");
  });

  it("does not rewrite scoped or semantics-changing rg and fd searches", () => {
    expect(evaluate({ tool_name: "Bash", tool_input: { command: "rg -n -C2 \"stale tooltip\" ." } }, defaultConfig)).toBeNull();
    expect(evaluate({ tool_name: "Bash", tool_input: { command: "rg --files src" } }, defaultConfig)).toBeNull();
    expect(evaluate({ tool_name: "Bash", tool_input: { command: "rg -F \"stale tooltip\" src" } }, defaultConfig)).toBeNull();
    expect(evaluate({ tool_name: "Bash", tool_input: { command: "fd tooltip src" } }, defaultConfig)).toBeNull();
  });

  it("rewrites recursive grep with the searched pattern", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "grep -rn \"stale tooltip\" ." } }, defaultConfig, {
      searchCommand: "node dist/src/cli/index.js search --repo /tmp/repo"
    });
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("node dist/src/cli/index.js search --repo /tmp/repo 'stale tooltip' --limit 20");
  });

  it("denies recursive grep with include filters because search cannot preserve them", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "grep -R --include '*.ts' -n \"stale tooltip\" ." } }, defaultConfig);
    expect(result?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain("--include option");
  });

  it("handles long grep flags without treating them as patterns", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "grep --recursive --line-number \"stale tooltip\" ." } }, defaultConfig);
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("frontload search 'stale tooltip' --limit 20");
  });

  it("denies recursive grep when it cannot be rewritten safely", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "grep -R -f patterns.txt ." } }, defaultConfig);
    expect(result?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain("pattern file");
  });

  it("denies recursive grep with unsupported match semantics", () => {
    const inverted = evaluate({ tool_name: "Bash", tool_input: { command: "grep -R -v \"stale tooltip\" ." } }, defaultConfig);
    const regex = evaluate({ tool_name: "Bash", tool_input: { command: "grep -R -E \"stale.*tooltip\" ." } }, defaultConfig);
    const context = evaluate({ tool_name: "Bash", tool_input: { command: "grep -R -C2 \"stale tooltip\" ." } }, defaultConfig);

    expect(inverted?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(inverted?.hookSpecificOutput.permissionDecisionReason).toContain("-v option");
    expect(regex?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(regex?.hookSpecificOutput.permissionDecisionReason).toContain("-E option");
    expect(context?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(context?.hookSpecificOutput.permissionDecisionReason).toContain("-C option");
  });

  it("rewrites lockfile cat through budgeted read", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "cat pnpm-lock.yaml" } }, defaultConfig, {
      readCommand: "frontload read --repo ."
    });
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("frontload read --repo . 'pnpm-lock.yaml' --budget 4000");
  });

  it("denies noisy generated and lockfile reads", () => {
    const generated = evaluate({ tool_name: "Read", tool_input: { file_path: "src/__snapshots__/view.snap" } }, defaultConfig);
    const lockfile = evaluate({ tool_name: "Read", tool_input: { file_path: "pnpm-lock.yaml" } }, defaultConfig);
    expect(generated?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(generated?.hookSpecificOutput.permissionDecisionReason).toContain("the agent");
    expect(lockfile?.hookSpecificOutput.permissionDecisionReason).toContain("the agent");
  });

  it("caps source read limits while preserving the tool input", () => {
    const missing = evaluate({ tool_name: "Read", tool_input: { file_path: "src/gate/gate.ts", description: "source read" } }, defaultConfig);
    const smaller = evaluate({ tool_name: "Read", tool_input: { file_path: "src/gate/gate.ts", limit: 50, description: "source read" } }, defaultConfig);
    const invalid = evaluate({ tool_name: "Read", tool_input: { file_path: "src/gate/gate.ts", limit: 0, description: "source read" } }, defaultConfig);
    const larger = evaluate({ tool_name: "Read", tool_input: { file_path: "src/gate/gate.ts", limit: 999, description: "source read" } }, defaultConfig);

    expect(missing?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(missing?.hookSpecificOutput.updatedInput).toEqual({ file_path: "src/gate/gate.ts", description: "source read", limit: 200 });
    expect(smaller?.hookSpecificOutput.updatedInput).toEqual({ file_path: "src/gate/gate.ts", limit: 50, description: "source read" });
    expect(invalid?.hookSpecificOutput.updatedInput).toEqual({ file_path: "src/gate/gate.ts", limit: 200, description: "source read" });
    expect(larger?.hookSpecificOutput.updatedInput).toEqual({ file_path: "src/gate/gate.ts", limit: 200, description: "source read" });
  });

  it("compacts tool output deterministically", () => {
    expect(() => compactToolOutput(["a"], 1)).toThrow("at least 2");

    expect(compactToolOutput("abc", 10)).toEqual({
      output: "abc",
      originalChars: 3,
      outputChars: 3,
      fitsBudget: true,
      truncated: false
    });

    expect(compactToolOutput(["a", "b"], 10)).toEqual({
      output: ["a", "b"],
      originalChars: JSON.stringify(["a", "b"]).length,
      outputChars: JSON.stringify(["a", "b"]).length,
      fitsBudget: true,
      truncated: false
    });

    const structured = { a: 1, nested: ["x"] };
    expect(compactToolOutput(structured, 100)).toEqual({
      output: structured,
      originalChars: JSON.stringify(structured).length,
      outputChars: JSON.stringify(structured).length,
      fitsBudget: true,
      truncated: false
    });

    const fixture = {
      filenames: Array.from({ length: 20 }, (_, i) => `src/path-${String(i).padStart(2, "0")}/very/long/file-name-${i}.ts`),
      durationMs: 12,
      numFiles: 100,
      truncated: false
    };
    const compacted = compactToolOutput(fixture, 140);
    expect(compacted.output).toMatchObject({
      durationMs: 12,
      numFiles: 100,
      truncated: true
    });
    expect(Array.isArray((compacted.output as { filenames: unknown }).filenames)).toBe(true);
    expect(JSON.stringify(compacted.output).length).toBeLessThanOrEqual(140);

    const metadataOnly = compactToolOutput({
      durationMs: Number.MAX_SAFE_INTEGER,
      numFiles: Number.MAX_SAFE_INTEGER,
      truncated: false
    }, 55);
    expect(metadataOnly.truncated).toBe(true);
    expect(metadataOnly.outputChars).toBeLessThanOrEqual(55);
    expect(metadataOnly.output).toMatchObject({
      truncated: true
    });

    const keyHeavy = compactToolOutput(Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`flag${i}`, false])
    ), 64);
    expect(keyHeavy.truncated).toBe(false);
    expect(keyHeavy.fitsBudget).toBe(false);
    expect(Object.keys(keyHeavy.output as Record<string, unknown>)).toHaveLength(100);

    const truncated = compactToolOutput("abcdefghijklmnopqrstuvwxyz".repeat(10), 64);
    expect(truncated.truncated).toBe(true);
    expect(typeof truncated.output).toBe("string");
    expect(String(truncated.output)).toContain("[Frontload truncated ");
    expect(String(truncated.output).length).toBeLessThanOrEqual(64);
  });

  it("allows unknown tools", () => {
    expect(evaluate({ tool_name: "Grep", tool_input: { pattern: "foo" } }, defaultConfig)).toBeNull();
  });

  it("stays inert when disabled", () => {
    expect(
      evaluate({ tool_name: "Bash", tool_input: { command: "pnpm test" } }, { gate: { ...defaultConfig.gate, enabled: false } })
    ).toBeNull();
  });
});
