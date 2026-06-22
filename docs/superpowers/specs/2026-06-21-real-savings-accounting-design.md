# Real Savings Accounting Design

## Goal

Report how many bytes Frontload actually saved for operations with a defensible
before/after baseline, while clearly separating operations that cannot be
measured without inventing a comparison.

## Measurement Contract

Every event records the actual model-visible Frontload payload:

- `outputChars`: character count used for the existing token estimate;
- `outputBytes`: UTF-8 byte count of the returned payload;
- `baselineBytes`: optional exact byte count for the comparison payload;
- `baselineKind`: required whenever `baselineBytes` is present;
- `netSavedBytes`: `baselineBytes - outputBytes`, including negative values.

`netSavedBytes` is signed. A small file read can legitimately cost more than
the full file once JSON metadata and numbered output are included. The report
must show that overhead instead of clamping it to zero.

## Exact Baselines

| Operation | Baseline kind | Baseline |
| --- | --- | --- |
| run | `raw-command-output` | captured stdout/stderr bytes before summarization |
| read | `full-file` | complete file bytes |
| diff | `raw-diff` | complete `git diff --patch` bytes |
| search | `unbounded-search-results` | the same Frontload response shape before `limit` is applied |
| local scout | `raw-local-scout-output` | complete captured local command output before capping |
| PostToolUse hook | `observed-tool-output` | observed native tool response before compaction |

Search savings are not described as native grep savings. They compare bounded
Frontload search with exact unbounded Frontload search output.

## Unmeasured Operations

Index, dossier, policy, and compare-cost events have no honest native output
baseline. They are logged with output bytes but without baseline fields. The
budget report counts them as unmeasured.

`fl_budget_report` and `frontload budget` do not log themselves, avoiding
self-referential report growth.

## CLI and MCP Equivalence

Measurement must use the same serialization users and agents receive:

- CLI strings are measured as strings; objects use two-space JSON. Both include
  the trailing newline emitted by the CLI.
- MCP measurements use the text placed in the MCP content response.
- Search baselines use the same CLI array or MCP wrapper shape as the bounded
  output, substituting only the unbounded result list.

The CLI and MCP use shared measurement helpers so byte and character counting
cannot drift.

`src/mcp/server.ts` exports a handler factory used by both `startMcp()` and the
e2e test. This keeps registration thin while letting tests invoke the exact
measured handlers and inspect their returned MCP text.

## Search API

Keep `searchIndex()` as the simple bounded-result API. Add
`searchIndexMeasured()` returning:

```ts
{
  results: Ranked[];
  unboundedResults: Ranked[];
}
```

Both inventory and ranked search compute the complete sorted match set once,
then slice for the bounded response.

## Diff API

`gitDiffSummary()` captures both numstat and patch output and returns
`rawDiffBytes`. The raw patch is not returned to the agent.

## Hook Accounting

PostToolUse records one event whenever Frontload observes an eligible response:

- compacted response: baseline is original response, output is replacement;
- already-small response: baseline and output are equal;
- schema-preserving compaction impossible: baseline and output are equal because
  the hook fails open.

PreToolUse rewrites are not assigned a savings number because command output is
not yet known.

## Report Shape

The budget report includes:

```ts
{
  operations: number;
  measuredOperations: number;
  unmeasuredOperations: number;
  totalBaselineBytes: number;
  totalMeasuredOutputBytes: number;
  netSavedBytes: number;
  estimatedTokensSaved: number;
  byOperation: {
    [operation: string]: {
      count: number;
      measuredCount: number;
      unmeasuredCount: number;
      outputChars: number;
      outputBytes: number;
      estimatedTokens: number;
      baselineBytes: number;
      measuredOutputBytes: number;
      netSavedBytes: number;
      baselineKinds: BaselineKind[];
    }
  }
}
```

The summary states measured savings and the unmeasured count. If
`netSavedBytes` is negative, it says the measured operations used extra bytes.

## Verification

Tests prove:

- signed event savings and aggregate report totals;
- exact CLI measurement for run/read/diff/search;
- MCP events use model-visible text and exact baselines;
- hook events record compacted, unchanged, and fail-open responses;
- unmeasured operations are counted without fake savings;
- existing compare-cost calculations continue to work.
