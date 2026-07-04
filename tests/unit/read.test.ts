import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBudgeted } from "../../src/commands/read.js";

function tempRepo(prefix = "frontload-read-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeLines(file: string, count: number): string[] {
  const lines = Array.from({ length: count }, (_, i) => `export const line${String(i + 1).padStart(2, "0")} = ${i + 1};`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return lines;
}

describe("budgeted read", () => {
  it("returns full small files with raw and numbered excerpts", () => {
    const result = readBudgeted(path.resolve("fixtures/react-ts-app"), "src/chart/ChartTooltip.tsx", { budgetChars: 10000 });

    expect(result.truncated).toBe(false);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(result.totalLines);
    expect(result.excerpt).toContain("export function ChartTooltip");
    expect(result.excerpt).not.toContain("1 |");
    expect(result.numberedExcerpt).toContain("   1 |");
    expect(result.editSafe).toBe(true);
  });

  it("returns explicit contiguous source windows that can be used for edits", () => {
    const dir = tempRepo();
    const lines = writeLines(path.join(dir, "src/big.ts"), 30);

    const result = readBudgeted(dir, "src/big.ts", { budgetChars: 4000, startLine: 10, lineCount: 4 });

    expect(result.startLine).toBe(10);
    expect(result.endLine).toBe(13);
    expect(result.excerpt).toBe(`${lines.slice(9, 13).join("\n")}\n`);
    expect(result.numberedExcerpt).toContain("  10 | export const line10 = 10;");
    expect(result.numberedExcerpt).toContain("  13 | export const line13 = 13;");
    expect(result.numberedExcerpt).not.toContain("  14 |");
    expect(result.nextRead).toContain("--start-line 14");
    expect(result.previousRead).toContain("--start-line 6");
    expect(result.editSafe).toBe(true);
  });

  it("omits duplicate numbered output when it would exceed the default tool cap", () => {
    const dir = tempRepo();
    const lines = Array.from({ length: 120 }, (_, i) => {
      const marker = i === 60 ? " targetNeedle" : "";
      return `export const paddedLine${String(i + 1).padStart(3, "0")} = "${"x".repeat(70)}";${marker}`;
    });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/large.ts"), `${lines.join("\n")}\n`);

    const result = readBudgeted(dir, "src/large.ts", { budgetChars: 4000, query: "targetNeedle" });
    const visibleChars = JSON.stringify(result, null, 2).length + 1;

    expect(result.excerpt).toContain("targetNeedle");
    expect(result.numberedExcerpt).toBeUndefined();
    expect(visibleChars).toBeLessThanOrEqual(8000);
  });

  it("fits query reads under caller-visible caps without dropping the match", () => {
    const dir = tempRepo();
    const lines = Array.from({ length: 90 }, (_, i) => {
      const marker = i === 60 ? " targetNeedle" : "";
      return `export const paddedLine${String(i + 1).padStart(3, "0")} = "${"x".repeat(130)}";${marker}`;
    });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/large.ts"), `${lines.join("\n")}\n`);

    const result = readBudgeted(dir, "src/large.ts", { budgetChars: 3500, query: "targetNeedle", maxSerializedChars: 2400 });
    const visibleChars = JSON.stringify(result, null, 2).length + 1;

    expect(result.excerpt).toContain("targetNeedle");
    expect(result.numberedExcerpt).toBeUndefined();
    expect(visibleChars).toBeLessThanOrEqual(2400);
  });

  it("uses query only to choose the first contiguous window", () => {
    const dir = tempRepo();
    const lines = writeLines(path.join(dir, "src/query.ts"), 40);
    fs.appendFileSync(path.join(dir, "src/query.ts"), "export const targetNeedle = true;\n");

    const result = readBudgeted(dir, "src/query.ts", { budgetChars: 240, query: "targetNeedle" });

    expect(result.startLine).toBeGreaterThanOrEqual(35);
    expect(result.endLine).toBe(41);
    expect(result.excerpt).toBe(`${lines.slice(result.startLine - 1, 40).join("\n")}\nexport const targetNeedle = true;\n`);
    expect(result.excerpt).not.toContain(lines[0]);
    expect(result.truncated).toBe(true);
  });

  it("does not advance past complete lines excluded by the character budget", () => {
    const dir = tempRepo();
    fs.writeFileSync(path.join(dir, "small-budget.ts"), "one\ntwo\nthree\nfour\n");

    const result = readBudgeted(dir, "small-budget.ts", { budgetChars: 5, startLine: 1, lineCount: 3 });

    expect(result.excerpt).toBe("one\n");
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(1);
    expect(result.nextRead).toContain("--start-line 2");
    expect(result.editSafe).toBe(true);
  });

  it("returns an oversized first line intact so paging cannot lose content", () => {
    const dir = tempRepo();
    const longLine = "A".repeat(200);
    fs.writeFileSync(path.join(dir, "long-line.ts"), `${longLine}\nsecond\n`);

    const result = readBudgeted(dir, "long-line.ts", { budgetChars: 80, startLine: 1, lineCount: 2 });

    expect(result.excerpt).toBe(`${longLine}\n`);
    expect(result.endLine).toBe(1);
    expect(result.nextRead).toContain("--start-line 2");
    expect(result.editSafe).toBe(true);
  });

  it("keeps a query match inside a line-count-limited window", () => {
    const dir = tempRepo();
    const lines = Array.from({ length: 20 }, (_, i) => (i === 14 ? "TARGET" : `line ${i + 1}`));
    fs.writeFileSync(path.join(dir, "query-window.ts"), `${lines.join("\n")}\n`);

    const result = readBudgeted(dir, "query-window.ts", { budgetChars: 4000, query: "TARGET", lineCount: 3 });

    expect(result.startLine).toBe(13);
    expect(result.endLine).toBe(15);
    expect(result.excerpt).toContain("TARGET");
  });

  it("rejects invalid numeric options before indexing line bounds", () => {
    const dir = tempRepo();
    fs.writeFileSync(path.join(dir, "invalid.ts"), "export const value = 1;\n");

    expect(() => readBudgeted(dir, "invalid.ts", { startLine: Number.NaN })).toThrow("startLine must be a positive integer");
    expect(() => readBudgeted(dir, "invalid.ts", { lineCount: 0 })).toThrow("lineCount must be a positive integer");
    expect(() => readBudgeted(dir, "invalid.ts", { budgetChars: -1 })).toThrow("budgetChars must be a positive integer");
  });

  it("marks redacted excerpts as not edit safe", () => {
    const dir = tempRepo();
    fs.writeFileSync(path.join(dir, "secret.ts"), "const apiKey = \"sk-abcdefghijklmnopqrstuvwxyz\";\nexport const x = 1;\n");

    const result = readBudgeted(dir, "secret.ts", { budgetChars: 4000 });

    expect(result.redactions).toBeGreaterThan(0);
    expect(result.excerpt).toContain("[REDACTED");
    expect(result.editSafe).toBe(false);
  });
});
