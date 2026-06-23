# Real Savings Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record and report exact before/after byte savings for operations with defensible baselines, and label every other operation unmeasured.

**Architecture:** Extend budget events with byte and baseline fields, centralize model-visible serialization and event measurement, expose baseline metadata from read/run/diff/search, and use the same measurement wrappers in CLI, MCP, and PostToolUse hooks.

**Tech Stack:** TypeScript, Node.js Buffer/fs, Commander, MCP SDK, Vitest.

---

## File Structure

- Modify `src/types.ts`
  - Add `BaselineKind` and byte/baseline fields to `BudgetEvent`.
- Modify `src/budget/events.ts`
  - Add serialization/size helpers, measured event creation, and aggregate savings.
- Modify `src/commands/read.ts`, `src/commands/run.ts`, `src/diff/diff.ts`
  - Expose exact baseline byte metadata already observed by each operation.
- Modify `src/dossier/dossier.ts`
  - Add one-pass bounded and unbounded search results.
- Modify `src/cli/index.ts`
  - Measure the exact payload passed to `print`.
- Modify `src/mcp/server.ts`
  - Export measured handlers and measure the exact text placed in MCP content.
- Modify `src/gate/entry.ts`
  - Record observed PostToolUse before/after bytes.
- Modify tests under `tests/unit` and `tests/e2e`
  - Verify exact totals, sources, baselines, and signed overhead.
- Modify `README.md` and `docs/mcp-tools.md`
  - Document measured versus unmeasured reporting.

## Task 1: Event Model and Aggregate Report

**Files:**
- Modify: `src/types.ts`
- Modify: `src/budget/events.ts`
- Modify: `tests/unit/diff-budget.test.ts`

- [x] **Step 1: Write failing event/report tests**

Add events equivalent to:

```ts
appendEvent(repo, {
  source: "cli",
  operation: "run",
  inputChars: 10,
  outputChars: 100,
  outputBytes: 100,
  baselineBytes: 1000,
  baselineKind: "raw-command-output",
  durationMs: 1,
  success: true
});

appendEvent(repo, {
  source: "cli",
  operation: "dossier",
  inputChars: 10,
  outputChars: 200,
  outputBytes: 200,
  durationMs: 1,
  success: true
});
```

Assert:

```ts
expect(readEvents(repo)[0].netSavedBytes).toBe(900);
expect(budgetReport(repo)).toMatchObject({
  operations: 2,
  measuredOperations: 1,
  unmeasuredOperations: 1,
  totalBaselineBytes: 1000,
  totalMeasuredOutputBytes: 100,
  netSavedBytes: 900,
  estimatedTokensSaved: 225
});
```

Add a measured read with `baselineBytes: 10` and `outputBytes: 30`; assert
`netSavedBytes` is `-20`, not zero.

- [x] **Step 2: Run the event tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/diff-budget.test.ts
```

Expected: type and assertion failures for missing byte/baseline fields.

- [x] **Step 3: Implement the event model**

Add:

```ts
export type BaselineKind =
  | "raw-command-output"
  | "full-file"
  | "raw-diff"
  | "unbounded-search-results"
  | "raw-local-scout-output"
  | "observed-tool-output";
```

`appendEvent()` computes signed `netSavedBytes` when a baseline exists and
rejects an event that supplies only one of `baselineBytes`/`baselineKind`.

Export shared helpers:

```ts
export function outputText(data: unknown): string;
export function outputSize(data: unknown): { chars: number; bytes: number };
```

Objects use `JSON.stringify(data, null, 2)`. Strings remain unchanged.

- [x] **Step 4: Implement aggregate reporting**

Aggregate measured and unmeasured counts, total baseline bytes, measured output
bytes, signed net savings, estimated saved tokens, baseline kinds, and existing
output/token totals by operation.

- [x] **Step 5: Run the event tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/diff-budget.test.ts
```

Expected: all event/report tests pass.

## Task 2: Exact Operation Baselines and CLI Measurement

**Files:**
- Modify: `src/commands/run.ts`
- Modify: `src/commands/read.ts`
- Modify: `src/diff/diff.ts`
- Modify: `src/dossier/dossier.ts`
- Modify: `src/cli/index.ts`
- Modify: `tests/unit/read.test.ts`
- Modify: `tests/unit/run.test.ts`
- Modify: `tests/unit/dossier.test.ts`
- Modify: `tests/unit/diff-budget.test.ts`

- [x] **Step 1: Write failing baseline tests**

Assert:

- `runSummary().rawOutputBytes` equals captured raw command bytes.
- `readBudgeted().fileSize` is used as the full-file baseline.
- `gitDiffSummary().rawDiffBytes` is greater than its bounded summary bytes for
  a verbose diff.
- `searchIndexMeasured(query, 1)` returns one bounded result and all sorted
  matches in `unboundedResults`.

Add a CLI integration helper or invoke built CLI commands in a temporary repo.
After `frontload run/read/diff/search`, inspect `readEvents()` and assert the
expected baseline kind and exact baseline bytes.

- [x] **Step 2: Run focused operation tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/read.test.ts tests/unit/run.test.ts tests/unit/dossier.test.ts tests/unit/diff-budget.test.ts
```

Expected: failures for missing `rawDiffBytes`, `searchIndexMeasured`, and CLI
baseline logging.

- [x] **Step 3: Add operation metadata**

Add `rawDiffBytes` to `gitDiffSummary()` by capturing `git diff --patch`.

Refactor search:

```ts
export type MeasuredSearchResult = {
  results: Ranked[];
  unboundedResults: Ranked[];
};

export async function searchIndexMeasured(
  repoRoot: string,
  query: string,
  limit?: number
): Promise<MeasuredSearchResult>;
```

`searchIndex()` returns `(await searchIndexMeasured(...)).results`.

- [x] **Step 4: Refactor CLI measurement**

Replace the current `outputLength()` wrapper with a measurement callback:

```ts
type ResultMeasurement<T> = {
  output: (result: T) => unknown;
  baseline?: (result: T) => { bytes: number; kind: BaselineKind };
};
```

Use the same value for measurement and `print()`:

- index: printed summary object, unmeasured;
- dossier: `result.markdown`, unmeasured;
- search: bounded array, baseline is unbounded array bytes;
- read: result object, baseline `fileSize`;
- run: result object, baseline `rawOutputBytes`;
- diff: result object, baseline `rawDiffBytes`;
- compare-cost: result object, unmeasured.

- [x] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/read.test.ts tests/unit/run.test.ts tests/unit/dossier.test.ts tests/unit/diff-budget.test.ts
```

Expected: all focused tests pass.

## Task 3: MCP Measurement

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `tests/e2e/cli-mcp.test.ts`

- [x] **Step 1: Add failing MCP event assertions**

Run MCP handlers in the existing e2e fixture, then inspect `readEvents(fixture)`.
Assert sources and baselines:

```ts
expect(events).toEqual(expect.arrayContaining([
  expect.objectContaining({ source: "mcp", operation: "read", baselineKind: "full-file" }),
  expect.objectContaining({ source: "mcp", operation: "run", baselineKind: "raw-command-output" }),
  expect.objectContaining({ source: "mcp", operation: "search", baselineKind: "unbounded-search-results" }),
  expect.objectContaining({ source: "mcp", operation: "dossier", baselineBytes: undefined })
]));
```

Assert each event's `outputBytes` equals the UTF-8 bytes of the text returned in
its MCP content.

- [x] **Step 2: Run e2e and verify RED**

Run:

```bash
pnpm e2e
```

Expected: missing MCP events.

- [x] **Step 3: Implement `measuredMcp`**

Create a wrapper that:

1. runs the tool handler;
2. builds the exact response data;
3. converts it to MCP text once;
4. appends a `source: "mcp"` event;
5. returns that same text.

Do not log `fl_budget_report` itself. Measure local scout against the uncapped
captured output when enabled.

Export:

```ts
export function createMcpHandlers(repoRoot: string): {
  policy(input: {}): Promise<McpTextResponse>;
  index(input: { force?: boolean }): Promise<McpTextResponse>;
  dossier(input: { task: string; budgetChars: number; maxFiles: number }): Promise<McpTextResponse>;
  search(input: { query: string; limit: number }): Promise<McpTextResponse>;
  read(input: ReadInput): Promise<McpTextResponse>;
  run(input: { kind: CommandSummary["kind"]; command: string }): Promise<McpTextResponse>;
  diff(input: { staged: boolean }): Promise<McpTextResponse>;
  budget(input: {}): Promise<McpTextResponse>;
  localScout(input: { prompt: string }): Promise<McpTextResponse>;
};
```

`startMcp()` registers these handlers without duplicating measurement logic.
The e2e test calls the factory handlers used by registration.

- [x] **Step 4: Run e2e and verify GREEN**

Run:

```bash
pnpm e2e
```

Expected: all e2e assertions pass.

## Task 4: Hook Measurement

**Files:**
- Modify: `src/gate/entry.ts`
- Modify: `tests/unit/hook-entry.test.ts`

- [x] **Step 1: Add failing hook event tests**

For compacted, unchanged, and schema-fail-open PostToolUse payloads, inspect
`readEvents(repo)` and assert:

```ts
{
  source: "hook",
  operation: "post-tool-use:Glob",
  baselineKind: "observed-tool-output"
}
```

Compacted output has positive savings. Unchanged and fail-open output have zero
savings.

- [x] **Step 2: Run hook tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/hook-entry.test.ts
```

Expected: no hook events are present.

- [x] **Step 3: Append exact PostToolUse events**

Measure the observed `tool_response` and the actual replacement value. If no
replacement is emitted, use the original response for both baseline and output.
Use the elapsed hook duration and serialized `tool_input` character count.

- [x] **Step 4: Run hook tests and verify GREEN**

Run:

```bash
pnpm vitest run tests/unit/hook-entry.test.ts
```

Expected: all hook tests pass.

## Task 5: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/mcp-tools.md`

- [x] **Step 1: Document measured versus unmeasured savings**

State the exact baseline table from the design. Explicitly say search compares
bounded versus unbounded Frontload results, not native grep. Show that negative
net savings represent measured overhead.

- [x] **Step 2: Run full verification**

Run:

```bash
pnpm build
pnpm test
pnpm e2e
git diff --check
```

Expected: zero TypeScript errors, all tests pass, and no whitespace errors.

- [x] **Step 3: Inspect final scope**

Run:

```bash
git status --short
git diff --stat codex/host-enforcement...HEAD
```

Expected: only real-savings accounting files differ from the stacked base.
