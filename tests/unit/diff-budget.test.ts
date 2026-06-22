import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { appendEvent, budgetReport, outputSize, outputText } from "../../src/budget/events.js";
import { compareCost, gitDiffSummary } from "../../src/diff/diff.js";

describe("diff and budget", () => {
  it("writes JSONL events and reports largest outputs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-budget-"));
    appendEvent(dir, { source: "cli", operation: "read", inputChars: 10, outputChars: 40, outputBytes: 40, durationMs: 1, success: true });
    const report = budgetReport(dir);
    expect(report.operations).toBe(1);
    expect(report.measuredOperations).toBe(0);
    expect(report.unmeasuredOperations).toBe(1);
    expect(report.byOperation.read.estimatedTokens).toBe(10);
    expect(report.byOperation.read.outputBytes).toBe(40);
    expect(report.summary).toContain("1 unmeasured operation");
  });

  it("exports output helpers", () => {
    expect(outputText("hello")).toBe("hello");
    expect(outputText({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(outputText(undefined)).toBe("undefined");
    expect(outputSize("å")).toEqual({ chars: 1, bytes: Buffer.byteLength("å") });
  });

  it("tracks measured savings and rounds estimated tokens saved", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-budget-measured-"));
    appendEvent(dir, {
      source: "cli",
      operation: "read",
      inputChars: 10,
      outputChars: 10,
      outputBytes: 10,
      baselineBytes: 24,
      baselineKind: "full-file",
      durationMs: 1,
      success: true
    });
    const report = budgetReport(dir);
    expect(report.measuredOperations).toBe(1);
    expect(report.unmeasuredOperations).toBe(0);
    expect(report.totalBaselineBytes).toBe(24);
    expect(report.totalMeasuredOutputBytes).toBe(10);
    expect(report.netSavedBytes).toBe(14);
    expect(report.estimatedTokensSaved).toBe(4);
    expect(report.byOperation.read.baselineBytes).toBe(24);
    expect(report.byOperation.read.measuredOutputBytes).toBe(10);
    expect(report.byOperation.read.netSavedBytes).toBe(14);
    expect(report.byOperation.read.baselineKinds).toEqual(["full-file"]);
    expect(report.baselineKinds).toEqual(["full-file"]);
    expect(report.summary).toContain("saved 14 bytes");
  });

  it("reports extra bytes when measured output is larger than baseline", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-budget-negative-"));
    appendEvent(dir, {
      source: "cli",
      operation: "read",
      inputChars: 10,
      outputChars: 10,
      outputBytes: 30,
      baselineBytes: 20,
      baselineKind: "raw-command-output",
      durationMs: 1,
      success: true
    });
    const report = budgetReport(dir);
    expect(report.netSavedBytes).toBe(-10);
    expect(report.estimatedTokensSaved).toBe(-2);
    expect(report.summary).toContain("used extra bytes");
  });

  it("counts unmeasured operations separately", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-budget-unmeasured-"));
    appendEvent(dir, { source: "cli", operation: "scan", inputChars: 10, outputChars: 25, outputBytes: 25, durationMs: 1, success: true });
    const report = budgetReport(dir);
    expect(report.measuredOperations).toBe(0);
    expect(report.unmeasuredOperations).toBe(1);
    expect(report.totalBaselineBytes).toBe(0);
    expect(report.totalMeasuredOutputBytes).toBe(0);
    expect(report.netSavedBytes).toBe(0);
    expect(report.estimatedTokensSaved).toBe(0);
  });

  it("rejects incomplete baseline metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-budget-invalid-baseline-"));
    expect(() => appendEvent(dir, {
      source: "cli",
      operation: "read",
      inputChars: 1,
      outputChars: 1,
      outputBytes: 1,
      baselineBytes: 10,
      durationMs: 1,
      success: true
    })).toThrow("baselineBytes and baselineKind");
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
    expect(summary.rawDiffBytes).toBeGreaterThan(Buffer.byteLength(summary.summary));
  });

  it("counts raw patch bytes exactly including the final newline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-diff-bytes-"));
    await execa("git", ["init"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "src.ts"), "export const a = 1;\n");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], {
      cwd: dir,
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" }
    });
    fs.writeFileSync(path.join(dir, "src.ts"), "export const a = 1;\nexport const b = 2;\n");
    const summary = await gitDiffSummary(dir);
    const actual = await execa("git", ["diff", "--patch"], { cwd: dir, stripFinalNewline: false });

    expect(summary.rawDiffBytes).toBe(Buffer.byteLength(actual.stdout));
    expect(summary.rawDiffBytes).toBeGreaterThan(0);
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
    appendEvent(dir, { source: "cli", operation: "dossier", inputChars: 10, outputChars: 400, outputBytes: 400, durationMs: 1, success: true });
    const result = await compareCost(dir, "HEAD~1", "HEAD");
    expect(result.changedFiles[0].path).toBe("src.ts");
    expect(result.baselines.changedFileTokens).toBeGreaterThan(0);
    expect(result.agentBudget.outputTokensExcludingIndex).toBe(100);
    expect(result.summary).toContain("Full changed-file baseline");
    expect(result.agentBudget.byOperation.dossier.count).toBe(1);
  });
});
