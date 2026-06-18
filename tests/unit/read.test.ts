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

  it("marks redacted excerpts as not edit safe", () => {
    const dir = tempRepo();
    fs.writeFileSync(path.join(dir, "secret.ts"), "const apiKey = \"sk-abcdefghijklmnopqrstuvwxyz\";\nexport const x = 1;\n");

    const result = readBudgeted(dir, "secret.ts", { budgetChars: 4000 });

    expect(result.redactions).toBeGreaterThan(0);
    expect(result.excerpt).toContain("[REDACTED");
    expect(result.editSafe).toBe(false);
  });
});
