import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/config.js";
import { evaluate } from "../../src/gate/gate.js";

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

  it("rewrites recursive grep with the searched pattern", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "grep -rn \"stale tooltip\" ." } }, defaultConfig, {
      searchCommand: "node dist/src/cli/index.js search --repo /tmp/repo"
    });
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("node dist/src/cli/index.js search --repo /tmp/repo 'stale tooltip' --limit 20");
  });

  it("skips grep option values when extracting the searched pattern", () => {
    const result = evaluate({ tool_name: "Bash", tool_input: { command: "grep -R --include '*.ts' -n \"stale tooltip\" ." } }, defaultConfig);
    expect(result?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result?.hookSpecificOutput.updatedInput?.command).toBe("frontload search 'stale tooltip' --limit 20");
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
    expect(lockfile?.hookSpecificOutput.permissionDecisionReason).toContain("fl_read_budgeted");
  });

  it("allows source reads and unknown tools", () => {
    expect(evaluate({ tool_name: "Read", tool_input: { file_path: "src/gate/gate.ts" } }, defaultConfig)).toBeNull();
    expect(evaluate({ tool_name: "Grep", tool_input: { pattern: "foo" } }, defaultConfig)).toBeNull();
  });

  it("stays inert when disabled", () => {
    expect(
      evaluate({ tool_name: "Bash", tool_input: { command: "pnpm test" } }, { gate: { ...defaultConfig.gate, enabled: false } })
    ).toBeNull();
  });
});
