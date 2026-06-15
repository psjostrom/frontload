# Frontload Gateway v0.1 — Codex Agent Handoff

## How to use this handoff

Give this entire file to a Codex CLI agent in a fresh local repository.

Recommended setup:

```bash
git init frontload
cd frontload
codex
```

Then paste this document and add:

```md
Build this locally in this repository. You may install npm packages and run commands. Iterate until `pnpm proof` passes. Do not stop at scaffolding. When done, show the exact commands you ran and the generated proof files.
```

Codex CLI is preferred over app-only/IDE workflows for this task because the agent must repeatedly install packages, build, test, run fixture commands, start an MCP stdio server, inspect generated proof files, and debug local CLI behavior.

---

# Build Spec: Frontload Gateway v0.1

## Role

You are a Codex coding agent. Build the complete artifact described below.

Do not only design it. Do not return a partial skeleton. Build, test, document, and prove that it works.

When implementation details are underspecified, make practical engineering decisions and document them. Ask questions only if the task is genuinely impossible without user input.

## Product name

`frontload`

## One-sentence goal

Build a local-first context and cost gateway for AI coding agents, with Codex as the primary supported client, that reduces expensive token usage by giving agents compact repo context, summarized command output, budgeted file reads, and measurable proof of compression.

## Problem

Heavy agentic coding workflows waste money because agents repeatedly:

- rediscover the repository from scratch
- read too many files
- dump raw test/build/typecheck output into context
- loop on failures without budget visibility
- use expensive model context for cheap exploration

This project should not replace Codex. It should make Codex cheaper and more disciplined.

## Core principle

The expensive agent should receive a compact dossier, not the whole repo.

Preferred workflow:

```text
local repo index
→ compact task dossier
→ budgeted reads
→ summarized tests/typechecks/diffs
→ measured output sizes
→ Codex reasons on the small useful context
```

Not:

```text
Codex greps everything
→ reads many files
→ runs tests
→ pastes huge logs
→ loops
```

## Required deliverables

The final repository must include:

```text
frontload/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  vitest.config.ts
  README.md
  AGENTS.example.md
  frontload.config.example.json

  src/
    cli/
    mcp/
    indexer/
    dossier/
    commands/
    diff/
    budget/
    hooks/
    config/
    utils/

  fixtures/
    react-ts-app/

  docs/
    architecture.md
    codex-setup.md
    mcp-tools.md
    security.md
    local-scout.md
    troubleshooting.md

  codex/
    config.example.toml
    AGENTS.md

  skills/
    frontload/
      SKILL.md

  hooks/
    hooks.json
    pre-tool-use-policy.ts
    post-tool-use-policy.ts

  proof/
    TEST_REPORT.md
    sample-dossier.md
    raw-vs-summary.json
    mcp-transcript.jsonl
```

If you choose a slightly different structure, preserve the same capabilities and document the differences.

## Required tech stack

Use:

- TypeScript
- Node.js 20+
- pnpm
- Vitest
- MCP TypeScript SDK
- `commander` or equivalent for CLI
- `zod` for schema validation
- `fast-glob` for repo scanning
- `ts-morph` or TypeScript compiler API for TypeScript/JavaScript symbol extraction
- `execa` or Node child process APIs for controlled command execution

Do not require a paid LLM API for tests.

Do not require Ollama/local models for the default path.

Do not make runtime network calls except normal package installation during development.

Avoid native dependencies unless clearly justified.

Store local state under:

```text
.frontload/
  index.json
  events.jsonl
  logs/
  cache/
```

Use JSON/JSONL for v0.1 instead of SQLite unless you strongly justify SQLite.

## Current implementation addendum

Before implementing MCP, verify the current official TypeScript MCP SDK package/import style.

The original spec mentions `@modelcontextprotocol/sdk`, but current examples may use imports from newer package paths such as `@modelcontextprotocol/server` and `@modelcontextprotocol/server/stdio`. Use the current official package/import style that installs, builds, and passes tests. Document the exact package/import choice in `docs/mcp-tools.md`.

In `docs/codex-setup.md`, document the global Codex config written by
`frontload init --agents codex`:

- an MCP server config in `~/.codex/config.toml`
- `enabled_tools` listing only the Frontload tools, if supported by the current Codex version
- `default_tools_approval_mode = "auto"` or `"prompt"`, with a documented recommendation

If any of these Codex config keys are unsupported in the installed/current Codex version, document the mismatch and provide the closest working config.

The project must still work if hooks are unavailable or disabled. Claude Code
hooks are the current enforced path; Codex setup is MCP plus skill guidance until
a Codex-native hook installer is implemented.

## Required CLI

Implement a binary called:

```bash
frontload
```

Required commands:

```bash
frontload init
frontload doctor
frontload index --repo .
frontload dossier "task description" --repo . --format markdown --budget 12000
frontload search "query" --repo . --limit 10
frontload read path/to/file.ts --repo . --budget 4000
frontload run --repo . --kind test -- pnpm test
frontload run --repo . --kind typecheck -- pnpm tsc --noEmit
frontload diff --repo .
frontload budget --repo .
frontload mcp --repo .
```

### CLI behavior

`frontload init` must create:

```text
frontload.config.json
AGENTS.md
.frontload/
```

It must not overwrite existing files unless `--force` is passed.

`frontload doctor` must verify:

- Node version
- package manager availability
- repository root detection
- config validity
- writable `.frontload/`
- git availability when needed
- MCP server can start
- fixture tests are runnable

`frontload index` must scan the repo and write `.frontload/index.json`.

`frontload dossier` must generate a compact task dossier.

`frontload run` must run an allowed command and return a summary, not raw unbounded output.

`frontload mcp` must start the MCP stdio server.

## Configuration

Implement `frontload.config.json`.

Example:

```json
{
  "repoRoot": ".",
  "ignore": [
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    "coverage/**",
    "ios/Pods/**",
    "android/.gradle/**",
    "**/*.lock"
  ],
  "index": {
    "maxFileBytes": 300000,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".kt", ".kts"]
  },
  "budgets": {
    "defaultDossierChars": 12000,
    "defaultReadChars": 4000,
    "maxToolOutputChars": 8000,
    "maxRawLogBytes": 5000000
  },
  "commands": {
    "allowed": [
      "pnpm test",
      "pnpm vitest",
      "pnpm tsc",
      "npm test",
      "yarn test",
      "npx tsc",
      "git diff",
      "git status"
    ],
    "timeoutMs": 120000
  },
  "security": {
    "redactSecrets": true,
    "blockDangerousShell": true
  },
  "localScout": {
    "enabled": false,
    "command": null,
    "timeoutMs": 60000,
    "maxOutputChars": 6000
  }
}
```

## Repo indexer

### Required capabilities

The indexer must extract:

For all supported files:

- path
- extension
- size
- last modified time
- content hash
- rough line count
- whether it is likely a test file
- keywords from path and filename

For TypeScript/JavaScript/TSX/JSX files:

- imports
- exports
- functions
- classes
- interfaces/types
- React components if reasonably detectable
- hooks if name starts with `use`
- simple dependency edges between files

For unsupported languages like Kotlin in v0.1:

- include file metadata
- include path/filename keywords
- include a small list of likely symbol names using regex fallback
- do not fail indexing because a parser is unavailable

### Required output

`.frontload/index.json` should contain:

```ts
type RepoIndex = {
  version: 1
  generatedAt: string
  repoRoot: string
  files: IndexedFile[]
  edges: DependencyEdge[]
  stats: {
    fileCount: number
    indexedBytes: number
    ignoredCount: number
  }
}
```

## Dossier generator

Implement:

```bash
frontload dossier "task description"
```

And MCP tool:

```text
fl_repo_dossier
```

### Required behavior

Given a task description, rank likely relevant files by:

- lexical match against path
- lexical match against symbols
- lexical match against imports/exports
- test file proximity
- dependency edges
- recent git changes if available

No LLM is required.

### Required dossier format

Markdown output:

```md
# Frontload Dossier

## Task

<task>

## Budget

- Requested budget: <chars>
- Estimated token equivalent: <chars / 4>
- Generated at: <timestamp>

## Most relevant files

1. `src/foo/Foo.tsx`
   - score: 91
   - why: path match, symbol match, related test
   - symbols: Foo, useFoo
   - related tests: src/foo/Foo.test.tsx

## Suggested read order

1. ...
2. ...

## Related tests / commands

- `pnpm test Foo`
- `pnpm tsc --noEmit`

## Dependency notes

- `Foo.tsx` imports `useFoo`
- `Foo.test.tsx` covers `Foo`

## Context limits

This dossier intentionally omits raw file contents. Use `fl_read_budgeted` for targeted reads.
```

The dossier must never exceed the requested budget by more than 10%, unless an explicit error is returned.

## Budgeted file reader

Implement:

```bash
frontload read src/foo/Foo.tsx --budget 4000
```

And MCP tool:

```text
fl_read_budgeted
```

### Required behavior

Return:

- file path
- file size
- line count
- requested budget
- excerpt
- whether truncated
- suggested next reads if truncated

Budgeting strategy:

- If file fits, return all contents.
- If too large, return:
  - imports
  - exported symbols
  - lines around matching query terms if query provided
  - otherwise top section + exported declarations
- Include line numbers.
- Redact likely secrets.

## Command summary runner

Implement:

```bash
frontload run --kind test -- pnpm test
frontload run --kind typecheck -- pnpm tsc --noEmit
frontload run --kind lint -- pnpm lint
```

And MCP tool:

```text
fl_run_summary
```

### Required behavior

Run only allowed commands unless `--allow-unconfigured` is explicitly passed.

Capture stdout/stderr to a full local log file:

```text
.frontload/logs/<timestamp>-<kind>.log
```

Return compact JSON and readable text summary:

```ts
type CommandSummary = {
  kind: "test" | "typecheck" | "lint" | "generic"
  command: string
  exitCode: number | null
  signal: string | null
  durationMs: number
  rawOutputBytes: number
  summaryChars: number
  compressionRatio: number
  fullLogPath: string
  redactions: number
  findings: Finding[]
  truncated: boolean
}
```

Finding:

```ts
type Finding = {
  severity: "error" | "warning" | "info"
  file?: string
  line?: number
  column?: number
  title: string
  detail?: string
  stack?: string[]
}
```

### Required parsers

Implement at minimum:

1. Vitest/Jest-like output parser
   - detect failing test file
   - detect failing test name
   - detect assertion expected/received when visible
   - detect stack frames with file and line

2. TypeScript parser
   - parse `path(line,column): error TS1234: message`
   - parse `path:line:column - error TS1234: message` if present

3. Generic parser
   - extract lines containing:
     - `error`
     - `failed`
     - `FAIL`
     - `AssertionError`
     - `Expected`
     - `Received`
   - include surrounding context, capped

### Required compression target

For fixture test logs:

- summary must be less than 15% of raw output OR below 8,000 chars
- summary must preserve the failing file and failing test name
- full raw log must still be available locally

## Git diff summary

Implement:

```bash
frontload diff --repo .
```

And MCP tool:

```text
fl_git_diff_summary
```

Required output:

- changed files
- added/removed line counts
- file categories: source/test/config/docs/generated/lockfile
- risky changes:
  - lockfiles
  - package scripts
  - env/config
  - auth/security filenames
  - large generated files
- compact hunk summaries

Do not paste entire diff by default.

## Budget logger

Every CLI and MCP operation must append to:

```text
.frontload/events.jsonl
```

Event fields:

```ts
type BudgetEvent = {
  timestamp: string
  source: "cli" | "mcp" | "hook"
  operation: string
  inputChars: number
  outputChars: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  durationMs: number
  success: boolean
}
```

Implement:

```bash
frontload budget --repo .
```

It should report:

- total operations
- largest outputs
- output chars by operation
- estimated tokens by operation
- last 20 operations

Use `chars / 4` as the approximate token estimate. Document that it is only an estimate.

## MCP server

Implement an MCP stdio server started by:

```bash
frontload mcp --repo .
```

Required tools:

```text
fl_policy
fl_repo_index
fl_repo_dossier
fl_search
fl_read_budgeted
fl_run_summary
fl_git_diff_summary
fl_budget_report
fl_local_scout
```

### Tool design requirements

Each MCP tool must have:

- compact description
- clear “when to use”
- clear “when not to use”
- strict zod/schema validation
- output caps
- structured JSON response
- human-readable `summary` field

Do not create many tiny overlapping tools. Tool overload is part of the problem.

### MCP tool behavior

`fl_policy`

Returns the current budget and command policy.

`fl_repo_index`

Runs or refreshes the repo index. Accepts `force?: boolean`.

`fl_repo_dossier`

Input:

```json
{
  "task": "Fix broken tooltip after reconnect",
  "budgetChars": 12000,
  "maxFiles": 12
}
```

`fl_search`

Input:

```json
{
  "query": "tooltip reconnect",
  "limit": 10
}
```

`fl_read_budgeted`

Input:

```json
{
  "path": "src/chart/Tooltip.tsx",
  "query": "reconnect tooltip",
  "budgetChars": 4000
}
```

`fl_run_summary`

Input:

```json
{
  "kind": "test",
  "command": "pnpm test"
}
```

`fl_git_diff_summary`

Input:

```json
{
  "staged": false
}
```

`fl_budget_report`

Returns budget events summary.

`fl_local_scout`

For v0.1 this must be implemented as an optional extension point.

If `localScout.enabled` is false, return:

```json
{
  "enabled": false,
  "summary": "Local scout is disabled. Configure localScout.command to enable it."
}
```

If enabled, run the configured local command with the prompt over stdin, cap output, log event, and return result.

This lets users plug in Ollama or another local model later without making v0.1 depend on it.

## Codex integration

The artifact must include Codex setup docs and skills.

### `docs/codex-setup.md`

Must document the working MCP stdio server entry that `frontload init` merges
into `~/.codex/config.toml`.

Preferred shape:

```toml
[mcp_servers.frontload]
command = "frontload"
args = ["mcp", "--repo", "."]
startup_timeout_sec = 20
tool_timeout_sec = 120
enabled = true
required = false
enabled_tools = [
  "fl_policy",
  "fl_repo_index",
  "fl_repo_dossier",
  "fl_search",
  "fl_read_budgeted",
  "fl_run_summary",
  "fl_git_diff_summary",
  "fl_budget_report",
  "fl_local_scout"
]
default_tools_approval_mode = "prompt"
```

If any keys are unsupported by the current Codex version, document that clearly
and provide a working config. Also state that Codex setup is currently advisory:
the installer writes MCP and skill guidance, not a hard PreToolUse gate.

### `AGENTS.example.md`

Must instruct Codex:

```md
# Frontload workflow

Before broad exploration, call `fl_repo_dossier`.

Prefer:
- `fl_search` over broad grep
- `fl_read_budgeted` over raw full-file reads
- `fl_run_summary` over raw test/typecheck commands
- `fl_git_diff_summary` over raw full diff dumps
- `fl_budget_report` before and after large tasks

Do not read unrelated files unless the dossier suggests them or you explain why.

Do not run more than two repair loops on the same failure without checking `fl_budget_report` and creating a new focused dossier.

When tests fail, pass only the summarized failure back into reasoning unless the full log is truly needed.
```

### Skill

Create:

```text
skills/frontload/SKILL.md
```

It should be short and practical. It should teach Codex when to use the MCP tools and how to avoid raw context pollution.

Required metadata:

```md
---
name: frontload
description: Use this when working in a code repository with the Frontload MCP server to reduce context, summarize tests, produce task dossiers, and avoid expensive broad exploration.
---
```

### Hooks

Implement and test hook scripts locally.

Required files:

```text
hooks/hooks.json
hooks/pre-tool-use-policy.ts
hooks/post-tool-use-policy.ts
```

`pre-tool-use-policy.ts` must read a Codex hook JSON object from stdin and:

1. Detect risky raw-output shell commands:
   - `cat package-lock.json`
   - `cat pnpm-lock.yaml`
   - `find .`
   - `ls -R`
   - `grep -R`
   - obviously huge `rg` commands without file/path limits
   - raw `npm test`, `pnpm test`, `yarn test`, `tsc`, or `eslint` commands that are not already wrapped by `frontload run`

2. For raw test/typecheck/lint commands, return an allowed `updatedInput.command` that rewrites to `frontload run --kind <kind> -- <original command>` when safe.

3. For dangerous broad dump commands, deny with a clear reason telling Codex which MCP tool to use instead.

4. For borderline commands, allow but add additional context suggesting the budgeted tool.

`post-tool-use-policy.ts` should be best-effort. It should detect very large Bash output if present in the hook payload and return feedback telling Codex to use `frontload run` next time. Do not rely on unstable transcript parsing.

Hook tests must feed sample hook JSON into the scripts and assert:

- broad dump commands are denied
- test commands are rewritten
- already wrapped commands are allowed
- unknown safe commands are allowed

If actual Codex hook behavior differs from the docs on the installed version, document it clearly and keep the scripts unit-tested against the documented schema.

## Fixture app

Create `fixtures/react-ts-app`.

It should be a small TypeScript/React-ish app with:

```text
src/
  chart/
    GlucoseChart.tsx
    ChartTooltip.tsx
    useGlucoseSeries.ts
    ChartTooltip.test.tsx
  sensor/
    sensorConnectionStore.ts
  unrelated/
    BillingSettings.ts
```

The fixture should include:

- a task-relevant tooltip bug
- one failing test with verbose output
- enough unrelated files to prove ranking works
- a `package.json` with scripts:
  - `test`
  - `typecheck`
  - `lint` if simple

The known task for proof:

```text
Fix stale chart tooltip value after sensor reconnect
```

The dossier for this task must rank these files near the top:

```text
src/chart/ChartTooltip.tsx
src/chart/GlucoseChart.tsx
src/chart/useGlucoseSeries.ts
src/sensor/sensorConnectionStore.ts
src/chart/ChartTooltip.test.tsx
```

It must not rank `src/unrelated/BillingSettings.ts` near the top.

## Tests

Implement unit and integration tests with Vitest.

Required test categories:

### Config tests

- loads default config
- loads repo config
- validates invalid config with helpful errors
- respects ignore globs

### Indexer tests

- indexes fixture files
- extracts TypeScript symbols
- extracts imports/exports
- marks test files
- builds dependency edges
- does not crash on unsupported file extensions

### Dossier tests

- ranks tooltip-related files for the known task
- excludes unrelated files from top results
- stays within budget
- includes suggested tests/commands

### Budgeted read tests

- returns full small files
- truncates large files
- includes line numbers
- respects budget
- redacts obvious secrets

### Command summary tests

- summarizes failing test output
- summarizes TypeScript errors
- keeps raw full log on disk
- returns non-zero exit code correctly
- reaches compression target on fixture logs
- redacts obvious secrets

### Diff summary tests

- summarizes changed files
- detects lockfile/config risk
- avoids full diff dumps

### Budget logger tests

- writes JSONL events
- reports largest outputs
- estimates tokens by chars / 4

### MCP tests

Create a small MCP client test that starts the MCP server and calls:

- `fl_policy`
- `fl_repo_index`
- `fl_repo_dossier`
- `fl_read_budgeted`
- `fl_run_summary`
- `fl_budget_report`

Store one successful transcript at:

```text
proof/mcp-transcript.jsonl
```

### Hook tests

- feed sample PreToolUse Bash payloads into hook scripts
- assert deny/rewrite/allow behavior

## Demo/proof scripts

Add package scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "vitest run tests/e2e",
    "demo:fixture": "pnpm build && node dist/cli/index.js index --repo fixtures/react-ts-app && node dist/cli/index.js dossier \"Fix stale chart tooltip value after sensor reconnect\" --repo fixtures/react-ts-app --format markdown --budget 12000 && node dist/cli/index.js run --repo fixtures/react-ts-app --kind test -- pnpm test",
    "proof": "pnpm build && pnpm test && pnpm e2e && pnpm demo:fixture"
  }
}
```

If exact script names differ, preserve equivalent behavior and document them.

## Proof artifacts

Generate these files during `pnpm proof`:

### `proof/TEST_REPORT.md`

Must include:

- date/time
- Node version
- pnpm version
- OS
- commands run
- pass/fail status
- test counts
- e2e results
- known limitations

### `proof/sample-dossier.md`

Must be generated from:

```bash
frontload dossier "Fix stale chart tooltip value after sensor reconnect" --repo fixtures/react-ts-app --format markdown --budget 12000
```

### `proof/raw-vs-summary.json`

Must include:

```json
{
  "command": "pnpm test",
  "rawOutputBytes": 12345,
  "summaryChars": 1234,
  "compressionRatio": 0.1,
  "preservedFindings": [
    "failing test name",
    "failing file",
    "assertion summary"
  ]
}
```

### `proof/mcp-transcript.jsonl`

Must show successful MCP calls and responses.

## Definition of Done

The project is done only when all of these are true:

1. `pnpm install` succeeds.
2. `pnpm build` succeeds.
3. `pnpm test` succeeds.
4. `pnpm e2e` succeeds.
5. `pnpm proof` succeeds.
6. `frontload doctor` succeeds on the fixture repo.
7. `frontload index --repo fixtures/react-ts-app` creates `.frontload/index.json`.
8. `frontload dossier "Fix stale chart tooltip value after sensor reconnect" --repo fixtures/react-ts-app` creates a useful bounded dossier.
9. The dossier ranks relevant tooltip/chart/sensor files above unrelated files.
10. `frontload run --repo fixtures/react-ts-app --kind test -- pnpm test` preserves the failing test information while compressing output.
11. The command summary writes the full raw log locally.
12. MCP server starts over stdio.
13. MCP client integration test successfully calls required tools.
14. Hook unit tests pass.
15. Documentation explains installation, Codex setup, security model, local scout extension, and limitations.
16. `proof/` contains generated evidence, not hand-written claims.
17. No test depends on paid LLM APIs.
18. No runtime path sends source code to an external service.
19. The final response includes exact commands run and whether they passed.

## Final response required from the Codex agent

When finished, respond with:

```md
# Frontload build complete

## What was built

<brief summary>

## How to run

<install and usage commands>

## Proof

Commands run:

- `pnpm install`
- `pnpm build`
- `pnpm test`
- `pnpm e2e`
- `pnpm proof`

Results:

<actual result summary>

Generated proof files:

- `proof/TEST_REPORT.md`
- `proof/sample-dossier.md`
- `proof/raw-vs-summary.json`
- `proof/mcp-transcript.jsonl`

## Codex setup

<how to add MCP config and AGENTS.md>

## Limitations

<honest limitations>

## Suggested next version

<short v0.2 ideas>
```

Do not claim success unless the commands actually passed.

---

# Extra instruction to Codex

Prefer simple, deterministic implementations over clever ones.

The value of v0.1 is not perfect semantic understanding. The value is:

- bounded context
- compact repository dossiers
- summarized command output
- visible budget logging
- Codex-compatible MCP tools
- proof that the workflow works locally

Build the smallest robust version that satisfies the DoD.
