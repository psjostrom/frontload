import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { appendEvent, budgetReport } from "../../src/budget/events.js";
import { compareCost, gitDiffSummary } from "../../src/diff/diff.js";

describe("diff and budget", () => {
  it("writes JSONL events and reports largest outputs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-budget-"));
    appendEvent(dir, { source: "cli", operation: "read", inputChars: 10, outputChars: 40, durationMs: 1, success: true });
    const report = budgetReport(dir);
    expect(report.operations).toBe(1);
    expect(report.byOperation.read.estimatedTokens).toBe(10);
  });

  it("summarizes changed files and detects lockfile risk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-diff-"));
    await execa("git", ["init"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir, env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" } });
    fs.appendFileSync(path.join(dir, "pnpm-lock.yaml"), "\nchanged");
    const summary = await gitDiffSummary(dir);
    expect(summary.changedFiles[0].category).toBe("lockfile");
    expect(summary.summary).not.toContain("diff --git");
  });

  it("compares changed-file and patch baselines against logged budget", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-cost-"));
    await execa("git", ["init"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "src.ts"), "export const a = 1;\n");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], { cwd: dir, env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" } });
    fs.writeFileSync(path.join(dir, "src.ts"), "export const a = 1;\nexport const b = 2;\n");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "change"], { cwd: dir, env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" } });
    appendEvent(dir, { source: "cli", operation: "dossier", inputChars: 10, outputChars: 400, durationMs: 1, success: true });
    const result = await compareCost(dir, "HEAD~1", "HEAD");
    expect(result.changedFiles[0].path).toBe("src.ts");
    expect(result.baselines.changedFileTokens).toBeGreaterThan(0);
    expect(result.agentBudget.outputTokensExcludingIndex).toBe(100);
    expect(result.summary).toContain("Full changed-file baseline");
  });
});
