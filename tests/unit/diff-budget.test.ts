import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { appendEvent, budgetReport, outputSize, outputText } from "../../src/budget/events.js";
import { boundedOutput } from "../../src/budget/output-bounds.js";
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

  it("orders largest operations by UTF-8 bytes instead of characters", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-budget-largest-bytes-"));
    appendEvent(dir, { source: "cli", operation: "ascii", inputChars: 1, outputChars: 4, outputBytes: 4, durationMs: 1, success: true });
    appendEvent(dir, { source: "cli", operation: "unicode", inputChars: 1, outputChars: 3, outputBytes: 6, durationMs: 1, success: true });

    const report = budgetReport(dir);

    expect(report.largest.map((event) => event.operation)).toEqual(["unicode", "ascii"]);
  });

  it("compacts oversized budget reports instead of withholding them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-budget-compact-"));
    for (let i = 0; i < 80; i += 1) {
      appendEvent(dir, {
        source: "mcp",
        operation: "read",
        inputChars: 20,
        outputChars: 100,
        outputBytes: 100,
        baselineBytes: 1000,
        baselineKind: "full-file",
        durationMs: 1,
        success: true
      });
    }
    const report = budgetReport(dir);
    const bounded = boundedOutput("budget", 8000, report).output as Record<string, unknown>;

    expect(outputSize(report).chars).toBeGreaterThan(8000);
    expect(outputSize(bounded).chars).toBeLessThanOrEqual(8000);
    expect(bounded.summary).toBe(report.summary);
    expect(bounded).toMatchObject({
      truncated: true,
      operation: "budget",
      operations: 80,
      measuredOperations: 80,
      omittedEventDetails: 30,
      byOperation: {
        read: expect.objectContaining({ count: 80, measuredCount: 80 })
      }
    });
    expect(bounded).not.toHaveProperty("largest");
    expect(bounded).not.toHaveProperty("last20");
  });

  it("counts omitted budget operation groups when aggregate details are trimmed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-budget-compact-groups-"));
    for (let i = 0; i < 40; i += 1) {
      appendEvent(dir, {
        source: "mcp",
        operation: `operation-${i}`,
        inputChars: 20,
        outputChars: 100,
        outputBytes: 100,
        baselineBytes: 1000,
        baselineKind: "full-file",
        durationMs: 1,
        success: true
      });
    }
    const bounded = boundedOutput("budget", 1200, budgetReport(dir)).output as Record<string, unknown>;

    expect(outputSize(bounded).chars).toBeLessThanOrEqual(1200);
    expect(bounded.omittedOperationGroups).toEqual(expect.any(Number));
    expect(bounded.omittedOperationGroups as number).toBeGreaterThan(0);
    expect(bounded).not.toHaveProperty("omittedOperations");
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
    expect(report.summary).toContain("This can be normal metadata overhead for small outputs.");
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

  it("includes untracked files in unstaged diff summaries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-diff-untracked-"));
    await execa("git", ["init"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "existing.ts"), "export const a = 1;\n");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], {
      cwd: dir,
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" }
    });
    fs.appendFileSync(path.join(dir, "existing.ts"), "export const b = 2;\n");
    fs.mkdirSync(path.join(dir, "new"));
    fs.writeFileSync(path.join(dir, "new", "feature.ts"), "export const feature = true;\n");
    fs.writeFileSync(path.join(dir, "new", "feature.test.ts"), "test('feature', () => {});\n");

    const summary = await gitDiffSummary(dir);

    expect(summary.changedFiles.map((file) => file.path)).toEqual(["existing.ts", "new/feature.test.ts", "new/feature.ts"]);
    expect(summary.changedFiles.find((file) => file.path === "new/feature.ts")).toMatchObject({
      status: "untracked",
      category: "source",
      added: 1,
      removed: 0,
      risky: false
    });
    expect(summary.summary).toContain("new/feature.ts: +1/-0, source, untracked");
    expect(summary.summary).toContain("2 untracked files omitted from diff body.");
    expect(summary.rawDiffBytes).toBeGreaterThan(0);
  });

  it("can preserve tracked-only diff summaries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-diff-tracked-only-"));
    await execa("git", ["init"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "existing.ts"), "export const a = 1;\n");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-m", "init"], {
      cwd: dir,
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com" }
    });
    fs.appendFileSync(path.join(dir, "existing.ts"), "export const b = 2;\n");
    fs.writeFileSync(path.join(dir, "new.ts"), "export const ignored = true;\n");

    const summary = await gitDiffSummary(dir, { trackedOnly: true });

    expect(summary.changedFiles.map((file) => file.path)).toEqual(["existing.ts"]);
    expect(summary.summary).not.toContain("untracked");
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
