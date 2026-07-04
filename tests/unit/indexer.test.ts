import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, loadFreshIndex } from "../../src/indexer/indexer.js";

const fixture = path.resolve("fixtures/react-ts-app");

describe("indexer", () => {
  it("indexes fixture files and extracts TypeScript symbols", async () => {
    const index = await buildIndex(fixture);
    const tooltip = index.files.find((f) => f.path === "src/chart/ChartTooltip.tsx");
    expect(tooltip?.exports).toContain("ChartTooltip");
    expect(tooltip?.functions).toContain("formatTooltipValue");
    expect(index.files.find((f) => f.path.endsWith("ChartTooltip.test.tsx"))?.isTest).toBe(true);
  });

  it("extracts imports and dependency edges", async () => {
    const index = await buildIndex(fixture);
    expect(index.edges.some((e) => e.from === "src/chart/GlucoseChart.tsx" && e.to === "src/chart/ChartTooltip.tsx")).toBe(true);
  });

  it("does not crash on unsupported extensions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abg-index-"));
    fs.writeFileSync(path.join(dir, "Sample.kt"), "class Sample\nfun callMe() = Unit\n");
    const index = await buildIndex(dir);
    expect(index.files[0].symbols).toContain("Sample");
  });

  it("ignores generated, worktree, and local-sensitive defaults during scans", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-default-ignore-index-"));
    const files = {
      ".codex/worktrees/w/src/worktree.ts": "export const worktree = 1;\n",
      ".next/server.ts": "export const nextGenerated = 1;\n",
      "out/generated.ts": "export const outGenerated = 1;\n",
      "nested/.env.local": "SECRET=value\n",
      "notes/AGENTS.local.md": "# local notes\n",
      "src/kept.ts": "export const kept = 1;\n"
    };
    for (const [file, content] of Object.entries(files)) {
      const absolute = path.join(dir, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }

    const index = await buildIndex(dir);

    expect(index.files.map((file) => file.path)).toEqual(["src/kept.ts"]);
  });

  it("freshens changed files without a manual full index command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-fresh-change-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/sample.ts"), "export function oldThing() { return 1; }\n");
    await buildIndex(dir);

    fs.writeFileSync(path.join(dir, "src/sample.ts"), "export function newThing() { return 2; }\n");
    const index = await loadFreshIndex(dir);
    const sample = index.files.find((file) => file.path === "src/sample.ts");

    expect(sample?.symbols).toContain("newThing");
    expect(sample?.symbols).not.toContain("oldThing");
  });

  it("freshens newly added and deleted files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-fresh-add-delete-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/old.ts"), "export const oldThing = 1;\n");
    await buildIndex(dir);

    fs.rmSync(path.join(dir, "src/old.ts"));
    fs.writeFileSync(path.join(dir, "src/new.ts"), "export const newThing = 2;\n");
    const index = await loadFreshIndex(dir);

    expect(index.files.some((file) => file.path === "src/old.ts")).toBe(false);
    expect(index.files.find((file) => file.path === "src/new.ts")?.symbols).toContain("newThing");
  });

  it("rebuilds dependency edges after a freshened import change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-fresh-edges-"));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(dir, "src/b.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(dir, "src/main.ts"), "import { a } from './a';\nconsole.log(a);\n");
    await buildIndex(dir);

    fs.writeFileSync(path.join(dir, "src/main.ts"), "import { b } from './b';\nconsole.log(b);\n");
    const index = await loadFreshIndex(dir);

    expect(index.edges.some((edge) => edge.from === "src/main.ts" && edge.to === "src/b.ts")).toBe(true);
    expect(index.edges.some((edge) => edge.from === "src/main.ts" && edge.to === "src/a.ts")).toBe(false);
  });
});
