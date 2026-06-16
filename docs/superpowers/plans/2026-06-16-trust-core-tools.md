# Trust Core Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Frontload's replacement read and search tools trustworthy enough to support later enforcement by returning editable contiguous reads and automatically refreshing stale indexes on access.

**Architecture:** Replace stitched read excerpts with contiguous file windows. Keep the edit-safe raw excerpt separate from the numbered display excerpt. Add an async fresh-index loader that reuses unchanged indexed files, reindexes changed or new files, drops deleted files, rebuilds dependency edges, and is used by dossier/search entry points.

**Tech Stack:** TypeScript, Node fs/path APIs, fast-glob, ts-morph, Vitest, Commander, MCP SDK.

---

## Scope

This plan covers the next PR only:

- Item #4 from the brief: budgeted read must return contiguous editable code.
- Item #5 from the brief: index freshness should be invisible for search and dossier calls.

This plan intentionally does not cover:

- Native Grep/Glob enforcement.
- Codex hard enforcement.
- Real before/after savings accounting.

## File Structure

- Modify `src/commands/read.ts`
  - Owns contiguous read window selection and read result shape.
  - Adds `ReadBudgetedOptions` and line window helpers.
  - Keeps reading synchronous so CLI/MCP callers remain simple.

- Modify `src/utils/text.ts`
  - Add `lineNumbered(text, startLine = 1)` support so display excerpts keep real file line numbers.

- Modify `src/cli/index.ts`
  - Update `frontload read` options to accept `--start-line` and `--line-count`.
  - Update measured input for read calls.

- Modify `src/mcp/server.ts`
  - Update `fl_read_budgeted` schema to accept `startLine` and `lineCount`.
  - Update tool description to state `excerpt` is contiguous/editable.

- Modify `src/indexer/indexer.ts`
  - Extract scanning, file analysis, edge building, and index writing helpers.
  - Add `loadFreshIndex(repoRoot, config?)`.

- Modify `src/dossier/dossier.ts`
  - Use `loadFreshIndex` in `generateDossier` and `searchIndex`.

- Modify `tests/unit/read.test.ts`
  - Cover raw contiguous excerpts, line-numbered display, paging metadata, query-selected windows, and redaction edit safety.

- Modify `tests/unit/indexer.test.ts`
  - Cover fresh loading after file creation, file edits, and file deletion.

- Modify `tests/unit/dossier.test.ts`
  - Cover `searchIndex` observing fresh symbols and fresh content after an index was built.

- Modify `tests/e2e/cli-mcp.test.ts`
  - Update the direct `readBudgeted` call to the new options-object API.
  - Assert the e2e transcript uses the edit-safe raw excerpt plus numbered display field.

- Modify docs/skill wording:
  - `docs/mcp-tools.md`
  - `plugins/codex/skills/frontload/SKILL.md`
  - `plugins/claude/skills/frontload/SKILL.md`

---

## Task 1: Contiguous Read Result Shape

**Files:**
- Modify: `src/utils/text.ts`
- Modify: `src/commands/read.ts`
- Test: `tests/unit/read.test.ts`

- [ ] **Step 1: Update the read tests first**

Replace `tests/unit/read.test.ts` with tests that describe the new contract:

```ts
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
```

- [ ] **Step 2: Run the read tests and verify they fail**

Run:

```bash
pnpm vitest run tests/unit/read.test.ts
```

Expected:

- TypeScript compile failure because `readBudgeted` still accepts positional `budgetChars` and `query`.
- Or assertion failure because `excerpt` still contains line numbers and stitched excerpts.

- [ ] **Step 3: Update `lineNumbered` to support real start lines**

Change `src/utils/text.ts`:

```ts
export function lineNumbered(text: string, startLine = 1): string {
  return text
    .split(/\r?\n/)
    .map((line, i) => `${String(startLine + i).padStart(4, " ")} | ${line}`)
    .join("\n");
}
```

- [ ] **Step 4: Replace stitched read logic with contiguous window logic**

Replace `src/commands/read.ts` with this structure:

```ts
import fs from "node:fs";
import path from "node:path";
import { loadIndex } from "../indexer/indexer.js";
import { capText, lineNumbered, redactSecrets, words } from "../utils/text.js";

export type ReadBudgetedOptions = {
  budgetChars?: number;
  query?: string;
  startLine?: number;
  lineCount?: number;
};

export type ReadBudgetedResult = {
  summary: string;
  path: string;
  fileSize: number;
  totalLines: number;
  requestedBudget: number;
  startLine: number;
  endLine: number;
  excerpt: string;
  numberedExcerpt: string;
  truncated: boolean;
  editSafe: boolean;
  nextRead?: string;
  previousRead?: string;
  suggestedNextReads: string[];
  redactions: number;
};

type LineBound = {
  start: number;
  end: number;
  contentEnd: number;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function lineBounds(text: string): LineBound[] {
  if (text.length === 0) return [{ start: 0, end: 0, contentEnd: 0 }];
  const bounds: LineBound[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    bounds.push({ start, end: i + 1, contentEnd: text[i - 1] === "\r" ? i - 1 : i });
    start = i + 1;
  }
  if (start < text.length) bounds.push({ start, end: text.length, contentEnd: text.length });
  return bounds;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function firstQueryLine(text: string, bounds: LineBound[], query?: string): number | null {
  const terms = words(query ?? "");
  const literal = query?.trim().toLowerCase();
  if (!literal && terms.length === 0) return null;

  for (let i = 0; i < bounds.length; i++) {
    const line = text.slice(bounds[i].start, bounds[i].contentEnd).toLowerCase();
    if ((literal && line.includes(literal)) || terms.some((term) => line.includes(term))) return i + 1;
  }
  return null;
}

function endLineForBudget(text: string, bounds: LineBound[], startLine: number, budgetChars: number, requestedLineCount?: number): number {
  if (requestedLineCount !== undefined) return clamp(startLine + Math.max(1, requestedLineCount) - 1, startLine, bounds.length);

  let endLine = startLine;
  for (let line = startLine; line <= bounds.length; line++) {
    const next = text.slice(bounds[startLine - 1].start, bounds[line - 1].end);
    if (next.length > budgetChars && line > startLine) break;
    endLine = line;
    if (next.length >= budgetChars) break;
  }
  return endLine;
}

function readCommand(filePath: string, startLine: number, budgetChars: number, lineCount?: number): string {
  return [
    "frontload read",
    shellQuote(filePath),
    `--start-line ${startLine}`,
    `--budget ${budgetChars}`,
    lineCount === undefined ? "" : `--line-count ${lineCount}`
  ].filter(Boolean).join(" ");
}

export function readBudgeted(repoRoot: string, filePath: string, options: ReadBudgetedOptions = {}): ReadBudgetedResult {
  const budgetChars = options.budgetChars ?? 4000;
  const abs = path.resolve(repoRoot, filePath);
  const textRaw = fs.readFileSync(abs, "utf8");
  const bounds = lineBounds(textRaw);
  const totalLines = bounds.length;

  const queryLine = firstQueryLine(textRaw, bounds, options.query);
  const requestedStartLine = options.startLine ?? queryLine ?? 1;
  const startLine = clamp(requestedStartLine, 1, totalLines);
  const endLine = endLineForBudget(textRaw, bounds, startLine, budgetChars, options.lineCount);
  const rawExcerpt = textRaw.slice(bounds[startLine - 1].start, bounds[endLine - 1].end);
  const redacted = redactSecrets(rawExcerpt);
  const capped = capText(redacted.text, budgetChars);
  const excerpt = capped.text;
  const numberedExcerpt = lineNumbered(excerpt.replace(/\n\n\[truncated \d+ chars\]$/, ""), startLine);
  const truncated = capped.truncated || startLine > 1 || endLine < totalLines;
  const index = loadIndex(repoRoot);
  const suggestedNextReads = index?.edges.filter((e) => e.from === filePath).map((e) => e.to).slice(0, 5) ?? [];
  const nextRead = endLine < totalLines ? readCommand(filePath, endLine + 1, budgetChars, options.lineCount) : undefined;
  const previousStart = options.lineCount ? Math.max(1, startLine - options.lineCount) : Math.max(1, startLine - Math.max(1, endLine - startLine + 1));
  const previousRead = startLine > 1 ? readCommand(filePath, previousStart, budgetChars, options.lineCount) : undefined;
  const editSafe = redacted.redactions === 0 && !capped.truncated;

  return {
    summary: truncated
      ? `Returned contiguous lines ${startLine}-${endLine} for ${filePath}; full file is ${textRaw.length} chars.`
      : `Returned full file ${filePath}.`,
    path: filePath,
    fileSize: Buffer.byteLength(textRaw),
    totalLines,
    requestedBudget: budgetChars,
    startLine,
    endLine,
    excerpt,
    numberedExcerpt,
    truncated,
    editSafe,
    ...(nextRead ? { nextRead } : {}),
    ...(previousRead ? { previousRead } : {}),
    suggestedNextReads,
    redactions: redacted.redactions
  };
}
```

- [ ] **Step 5: Run the read tests and tighten implementation**

Run:

```bash
pnpm vitest run tests/unit/read.test.ts
```

Expected:

- PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/utils/text.ts src/commands/read.ts tests/unit/read.test.ts
git commit -m "Make budgeted reads contiguous"
```

---

## Task 2: Wire Read Paging Through CLI And MCP

**Files:**
- Modify: `src/cli/index.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/unit/read.test.ts`
- Test: `tests/e2e/cli-mcp.test.ts`

- [ ] **Step 1: Update CLI read call**

In `src/cli/index.ts`, replace the `program.command("read")` block with:

```ts
program.command("read")
  .argument("<path>")
  .option("--repo <repo>", "repository root", ".")
  .option("--budget <chars>", "4000")
  .option("--query <query>")
  .option("--start-line <line>", "1-based start line")
  .option("--line-count <count>", "maximum number of lines to return")
  .action(async (file, opts) => {
    const repoRoot = resolveRepo(opts.repo);
    const readOptions = {
      budgetChars: Number(opts.budget),
      query: opts.query as string | undefined,
      startLine: opts.startLine === undefined ? undefined : Number(opts.startLine),
      lineCount: opts.lineCount === undefined ? undefined : Number(opts.lineCount)
    };
    print(await measured(repoRoot, "read", { file, opts: readOptions }, () => readBudgeted(repoRoot, file, readOptions)));
  });
```

- [ ] **Step 2: Update MCP schema and tool description**

In `src/mcp/server.ts`, replace the `fl_read_budgeted` tool registration with:

```ts
server.tool(
  "fl_read_budgeted",
  "Read a contiguous, bounded file excerpt. The `excerpt` field is edit-safe when `editSafe` is true; use `numberedExcerpt` for line-number display.",
  {
    path: z.string(),
    query: z.string().optional(),
    budgetChars: z.number().default(4000),
    startLine: z.number().int().positive().optional(),
    lineCount: z.number().int().positive().optional()
  },
  async (input) => json(readBudgeted(repoRoot, input.path, {
    budgetChars: input.budgetChars,
    query: input.query,
    startLine: input.startLine,
    lineCount: input.lineCount
  }))
);
```

- [ ] **Step 3: Run typecheck/build to catch call-site drift**

Run:

```bash
pnpm build
```

Expected:

- PASS.

If TypeScript reports old positional calls to `readBudgeted`, update those call sites to pass `{ budgetChars, query }`.

- [ ] **Step 4: Update the e2e proof workflow direct read call**

In `tests/e2e/cli-mcp.test.ts`, replace the `fl_read_budgeted` call in the `calls` array:

```ts
["fl_read_budgeted", readBudgeted(fixture, "src/chart/ChartTooltip.tsx", 4000, "tooltip reconnect")],
```

with:

```ts
["fl_read_budgeted", readBudgeted(fixture, "src/chart/ChartTooltip.tsx", { budgetChars: 4000, query: "tooltip reconnect" })],
```

Then add these assertions near the existing `expect(dossier.markdown)` assertion:

```ts
const read = calls.find(([tool]) => tool === "fl_read_budgeted")?.[1] as ReturnType<typeof readBudgeted>;
expect(read.excerpt).not.toContain("1 |");
expect(read.numberedExcerpt).toContain("|");
expect(read.editSafe).toBe(true);
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm vitest run tests/unit/read.test.ts
pnpm build
```

Expected:

- Both commands pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/cli/index.ts src/mcp/server.ts tests/e2e/cli-mcp.test.ts
git commit -m "Expose budgeted read paging"
```

---

## Task 3: Fresh Index Loader

**Files:**
- Modify: `src/indexer/indexer.ts`
- Test: `tests/unit/indexer.test.ts`

- [ ] **Step 1: Add index freshness tests first**

In `tests/unit/indexer.test.ts`, change the existing indexer import to:

```ts
import { buildIndex, loadFreshIndex } from "../../src/indexer/indexer.js";
```

Add tests:

```ts
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
```

- [ ] **Step 2: Run indexer tests and verify failure**

Run:

```bash
pnpm vitest run tests/unit/indexer.test.ts
```

Expected:

- TypeScript compile failure because `loadFreshIndex` does not exist.

- [ ] **Step 3: Refactor indexer helpers**

In `src/indexer/indexer.ts`, add these helper types and functions below `resolveImport`:

```ts
type FileCandidate = {
  abs: string;
  path: string;
  extension: string;
  size: number;
  mtimeMs: number;
};

type ScanResult = {
  candidates: FileCandidate[];
  ignoredCount: number;
};

async function scanIndexableFiles(repoRoot: string, config: FrontloadConfig): Promise<ScanResult> {
  const entries = await fg(["**/*"], {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    ignore: config.ignore,
    absolute: true
  });
  const candidates: FileCandidate[] = [];
  let ignoredCount = 0;

  for (const abs of entries) {
    const st = fs.statSync(abs);
    const ext = path.extname(abs);
    if (!config.index.extensions.includes(ext) || st.size > config.index.maxFileBytes) {
      ignoredCount += 1;
      continue;
    }
    candidates.push({
      abs,
      path: rel(repoRoot, abs),
      extension: ext,
      size: st.size,
      mtimeMs: st.mtimeMs
    });
  }

  return { candidates, ignoredCount };
}

function analyzeFile(candidate: FileCandidate): IndexedFile {
  const text = fs.readFileSync(candidate.abs, "utf8");
  const base = {
    path: candidate.path,
    extension: candidate.extension,
    size: candidate.size,
    mtimeMs: candidate.mtimeMs,
    hash: hash(text),
    lineCount: text.split(/\r?\n/).length,
    isTest: /(^|[./_-])(test|spec)\.[jt]sx?$/.test(candidate.path) || /\.(test|spec)\.[jt]sx?$/.test(candidate.path),
    keywords: keywords(candidate.path)
  };
  const symbols = codeExts.has(candidate.extension)
    ? analyzeCode(candidate.path, text)
    : { imports: [], exports: [], functions: [], classes: [], types: [], components: [], hooks: [], symbols: fallbackSymbols(text) };
  return { ...base, ...symbols };
}

function buildEdges(files: IndexedFile[]): DependencyEdge[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const edges: DependencyEdge[] = [];
  for (const file of files) {
    for (const spec of file.imports) {
      const to = resolveImport(file.path, spec, byPath);
      if (to) edges.push({ from: file.path, to, importPath: spec });
    }
  }
  return edges;
}

function writeIndex(repoRoot: string, files: IndexedFile[], ignoredCount: number): RepoIndex {
  const edges = buildEdges(files);
  const index: RepoIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoRoot,
    files,
    edges,
    stats: {
      fileCount: files.length,
      indexedBytes: files.reduce((sum, file) => sum + file.size, 0),
      ignoredCount
    }
  };
  fs.mkdirSync(stateDir(repoRoot), { recursive: true });
  const out = path.join(stateDir(repoRoot), "index.json");
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, out);
  return index;
}
```

- [ ] **Step 4: Rebuild `buildIndex` using the helpers**

Replace `buildIndex` with:

```ts
export async function buildIndex(repoRoot: string, config: FrontloadConfig = loadConfig(repoRoot)): Promise<RepoIndex> {
  const scan = await scanIndexableFiles(repoRoot, config);
  const files = scan.candidates.map(analyzeFile);
  return writeIndex(repoRoot, files, scan.ignoredCount);
}
```

- [ ] **Step 5: Add `loadFreshIndex`**

Add this export below `loadIndex`:

```ts
export async function loadFreshIndex(repoRoot: string, config: FrontloadConfig = loadConfig(repoRoot)): Promise<RepoIndex> {
  const existing = loadIndex(repoRoot);
  if (!existing) return buildIndex(repoRoot, config);

  const scan = await scanIndexableFiles(repoRoot, config);
  const existingByPath = new Map(existing.files.map((file) => [file.path, file]));
  let changed = existing.files.length !== scan.candidates.length;

  const files = scan.candidates.map((candidate) => {
    const previous = existingByPath.get(candidate.path);
    if (previous && previous.size === candidate.size && previous.mtimeMs === candidate.mtimeMs) return previous;
    changed = true;
    return analyzeFile(candidate);
  });

  if (!changed) return existing;
  return writeIndex(repoRoot, files, scan.ignoredCount);
}
```

- [ ] **Step 6: Run indexer tests**

Run:

```bash
pnpm vitest run tests/unit/indexer.test.ts
```

Expected:

- PASS.

If mtime resolution makes the changed-file test flaky, keep the size change in the rewritten file and compare both `size` and `mtimeMs` as above.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/indexer/indexer.ts tests/unit/indexer.test.ts
git commit -m "Refresh stale indexes on access"
```

---

## Task 4: Use Fresh Indexes In Search And Dossier

**Files:**
- Modify: `src/dossier/dossier.ts`
- Test: `tests/unit/dossier.test.ts`

- [ ] **Step 1: Add search freshness tests first**

Append to `tests/unit/dossier.test.ts`:

```ts
import { buildIndex } from "../../src/indexer/indexer.js";
```

If imports already exist, merge this import with the existing import section.

Add tests:

```ts
it("searchIndex sees symbols added after the last explicit index build", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-search-fresh-symbol-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/sample.ts"), "export function oldThing() { return 1; }\n");
  await buildIndex(dir);

  fs.writeFileSync(path.join(dir, "src/sample.ts"), "export function newThing() { return 2; }\n");
  const results = await searchIndex(dir, "newThing", 5);

  expect(results[0]?.file.path).toBe("src/sample.ts");
  expect(results[0]?.file.symbols).toContain("newThing");
  expect(results[0]?.file.symbols).not.toContain("oldThing");
});

it("searchIndex sees files added after the last explicit index build", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frontload-search-fresh-file-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/old.ts"), "export const oldThing = 1;\n");
  await buildIndex(dir);

  fs.writeFileSync(path.join(dir, "src/new.ts"), "export const brandNewNeedle = 2;\n");
  const results = await searchIndex(dir, "brandNewNeedle", 5);

  expect(results.some((result) => result.file.path === "src/new.ts")).toBe(true);
});
```

- [ ] **Step 2: Run dossier tests and verify failure**

Run:

```bash
pnpm vitest run tests/unit/dossier.test.ts
```

Expected:

- Tests fail because `searchIndex` still uses `loadIndex(repoRoot) ?? buildIndex(repoRoot)`.

- [ ] **Step 3: Switch dossier/search to fresh index loading**

In `src/dossier/dossier.ts`, change the import:

```ts
import { buildIndex, loadIndex } from "../indexer/indexer.js";
```

to:

```ts
import { loadFreshIndex } from "../indexer/indexer.js";
```

Then change both index loaders:

```ts
const index = loadIndex(repoRoot) ?? (await buildIndex(repoRoot));
```

to:

```ts
const index = await loadFreshIndex(repoRoot);
```

Apply this in both `generateDossier` and `searchIndex`.

- [ ] **Step 4: Run dossier tests**

Run:

```bash
pnpm vitest run tests/unit/dossier.test.ts
```

Expected:

- PASS.

- [ ] **Step 5: Run combined targeted tests**

Run:

```bash
pnpm vitest run tests/unit/read.test.ts tests/unit/indexer.test.ts tests/unit/dossier.test.ts
```

Expected:

- PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/dossier/dossier.ts tests/unit/dossier.test.ts
git commit -m "Use fresh indexes for search and dossiers"
```

---

## Task 5: User-Facing Wording And Final Verification

**Files:**
- Modify: `docs/mcp-tools.md`
- Modify: `plugins/codex/skills/frontload/SKILL.md`
- Modify: `plugins/claude/skills/frontload/SKILL.md`

- [ ] **Step 1: Update tool docs with the new read contract**

Append this paragraph to `docs/mcp-tools.md` after the tool list:

```md
`fl_read_budgeted` returns a contiguous `excerpt` that can be used for edits when `editSafe` is true. Use `numberedExcerpt` for display and line references. Follow `nextRead` or `previousRead` to page through large files.
```

- [ ] **Step 2: Update Codex skill wording**

In `plugins/codex/skills/frontload/SKILL.md`, replace:

```md
3. Use `fl_read_budgeted` for file contents instead of raw full-file reads.
```

with:

```md
3. Use `fl_read_budgeted` for contiguous file windows instead of raw full-file reads. Prefer the raw `excerpt` for edits when `editSafe` is true, and use `numberedExcerpt` only for line references.
```

- [ ] **Step 3: Update Claude skill wording**

In `plugins/claude/skills/frontload/SKILL.md`, replace:

```md
3. Read file contents through budgeted reads instead of raw full-file reads.
```

with:

```md
3. Read contiguous file windows through budgeted reads instead of raw full-file reads. Prefer the raw excerpt for edits when editSafe is true, and use numberedExcerpt only for line references.
```

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm vitest run tests/unit/read.test.ts tests/unit/indexer.test.ts tests/unit/dossier.test.ts
pnpm build
pnpm test
pnpm e2e
git diff --check
```

Expected:

- All commands pass.
- `git diff --check` prints no whitespace errors.

- [ ] **Step 5: Inspect proof timestamp churn**

After `pnpm e2e`, run:

```bash
git status -sb
```

Expected:

- Only intended source, test, and doc files are modified.
- If `proof/mcp-transcript.jsonl` changes only by timestamp churn, restore that file by applying a minimal patch or checking out only that file after confirming the diff contains no intended change.

- [ ] **Step 6: Commit docs and verification polish**

```bash
git add docs/mcp-tools.md plugins/codex/skills/frontload/SKILL.md plugins/claude/skills/frontload/SKILL.md
git commit -m "Document editable budgeted reads"
```

- [ ] **Step 7: Open PR**

Use the GitHub app or CLI fallback:

```bash
git push -u origin codex/trust-core-tools
gh pr create --draft --base main --head codex/trust-core-tools --title "[codex] Make Frontload core tools trustworthy" --body-file /tmp/frontload-pr-body.md
```

PR body:

```md
## Summary
- make `fl_read_budgeted` return contiguous editable excerpts with separate numbered display output
- add read paging metadata and CLI/MCP paging options
- refresh stale indexes on search/dossier access so changed, added, and deleted files are reflected automatically

## Validation
- pnpm vitest run tests/unit/read.test.ts tests/unit/indexer.test.ts tests/unit/dossier.test.ts
- pnpm build
- pnpm test
- pnpm e2e
- git diff --check
```

---

## Self-Review Checklist

- [ ] Item #4 coverage: source reads no longer stitch unrelated lines together.
- [ ] Item #4 coverage: `excerpt` is raw contiguous text; line numbers live in `numberedExcerpt`.
- [ ] Item #4 coverage: redacted reads are marked `editSafe: false`.
- [ ] Item #4 coverage: callers can page with `startLine` and `lineCount`.
- [ ] Item #5 coverage: `searchIndex` sees changed symbols without manual `frontload index`.
- [ ] Item #5 coverage: `searchIndex` sees newly added files.
- [ ] Item #5 coverage: stale deleted files disappear from fresh indexes.
- [ ] Item #5 coverage: dependency edges rebuild after import changes.
- [ ] Scope check: no native Grep/Glob enforcement in this PR.
- [ ] Scope check: no savings-accounting schema changes in this PR.
