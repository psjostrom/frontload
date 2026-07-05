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
      ".Codex/worktrees/noisy/generated.ts": "export const hiddenAgentState = 1;\n",
      ".codex/worktrees/w/src/worktree.ts": "export const worktree = 1;\n",
      ".next/server.ts": "export const nextGenerated = 1;\n",
      "apps/site/.turbo/cache/generated.ts": "export const turboGenerated = 1;\n",
      "apps/site/.cache/generated.ts": "export const cacheGenerated = 1;\n",
      "apps/mobile/.expo/generated.ts": "export const expoGenerated = 1;\n",
      "android/.gradle/generated.ts": "export const gradleGenerated = 1;\n",
      "ios/Pods/generated.ts": "export const podGenerated = 1;\n",
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

  it("treats configured extensions as literal path extensions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-literal-extension-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{\"name\":\"ok\"}\n");
    fs.writeFileSync(path.join(dir, "package-lockjson"), "{\"name\":\"not-an-extension\"}\n");
    fs.writeFileSync(path.join(dir, "settings.ts"), "export const broadGlob = true;\n");

    const index = await buildIndex(dir, {
      repoRoot: ".",
      ignore: [],
      index: { maxFileBytes: 300000, extensions: ["json", ".{json,ts}"] },
      budgets: { defaultDossierChars: 6000, defaultReadChars: 4000, maxToolOutputChars: 8000, maxRawLogBytes: 5000000 },
      commands: { allowed: [], timeoutMs: 120000 },
      security: { redactSecrets: true, blockDangerousShell: true },
      localScout: { enabled: false, command: null, timeoutMs: 60000, maxOutputChars: 6000 },
      gate: { enabled: true, rewriteCommands: true, blockBroadShell: true, blockNoisyReads: true, maxReadLines: 200 }
    });

    expect(index.files.map((file) => file.path)).toEqual(["package.json"]);
    expect(index.stats.ignoredCount).toBe(0);
  });

  it("counts matched files skipped by index limits without scanning unsupported files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-ignored-count-"));
    fs.writeFileSync(path.join(dir, "readme.md"), "# indexed\n");
    fs.writeFileSync(path.join(dir, "large.md"), "x".repeat(12));
    fs.writeFileSync(path.join(dir, "notes.txt"), "not-indexed\n");

    const index = await buildIndex(dir, {
      repoRoot: ".",
      ignore: [],
      index: { maxFileBytes: 10, extensions: [".md"] },
      budgets: { defaultDossierChars: 6000, defaultReadChars: 4000, maxToolOutputChars: 8000, maxRawLogBytes: 5000000 },
      commands: { allowed: [], timeoutMs: 120000 },
      security: { redactSecrets: true, blockDangerousShell: true },
      localScout: { enabled: false, command: null, timeoutMs: 60000, maxOutputChars: 6000 },
      gate: { enabled: true, rewriteCommands: true, blockBroadShell: true, blockNoisyReads: true, maxReadLines: 200 }
    });

    expect(index.files.map((file) => file.path)).toEqual(["readme.md"]);
    expect(index.stats.ignoredCount).toBe(1);
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
