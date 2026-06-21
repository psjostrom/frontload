# frontload

`frontload` is a local-first context and cost gateway for coding agents.

It helps an expensive coding agent work from compact, relevant context instead of repeatedly reading the whole repository, dumping raw test logs into chat, and rediscovering the same files on every loop.

The core idea is simple:

```text
repo index -> task dossier -> budgeted reads -> summarized commands -> budget report
```

Source code stays local. `frontload` does not call an LLM API.

## Why

Agentic coding gets expensive when the agent:

- explores a repo from scratch every turn
- reads large source, fixture, generated, or docs files when only a small excerpt is useful
- pastes raw test, typecheck, build, or lint output into model context
- repeats repair loops without seeing how much context each loop costs
- treats docs, tests, generated files, and source files as equally relevant

`frontload` gives the agent smaller and more deliberate inputs:

- a compact repository index with paths, symbols, imports, and file metadata
- a task dossier that ranks likely files and flags noisy rankings
- budgeted file reads with line numbers and redaction
- command summaries that preserve failures while storing full logs locally
- diff and cost reports that quantify how much context was saved
- an MCP server so Codex can use the same tools directly

## Status

This is an early local tool. It is useful for measuring and shaping context, but it is not a replacement for judgment. Ranking is lexical and heuristic, not semantic. You should still verify suggested files and tests.

## Install

Requirements:

- Node.js 20+
- pnpm
- git

From this repository:

```bash
pnpm install
pnpm build
```

The CLI binary is built at:

```bash
dist/src/cli/index.js
```

During local development, run it with:

```bash
node dist/src/cli/index.js --help
```

If installed as a package, the binary name is:

```bash
frontload
```

## Quick Start

In a target repository:

```bash
npx frontload init
frontload doctor
frontload index --repo .
frontload dossier "Fix stale chart tooltip value after sensor reconnect" --repo .
frontload read src/chart/ChartTooltip.tsx --repo . --budget 4000
frontload run --repo . --kind test -- pnpm test
frontload budget --repo .
```

If you already installed the package globally, use `frontload init`.
The init command asks which agents to configure. For automation, pass `--agents codex`, `--agents claude`, `--agents all`, or `--agents none`.

Local state is written to `.frontload/` in the target repo:

```text
.frontload/
  index.json
  events.jsonl
  logs/
  cache/
```

Add `.frontload/` to the target repo's `.gitignore`.

## Daily Workflow

### 1. Index the repo

```bash
frontload index --repo .
```

The index records supported files, symbols, imports, dependency edges, sizes, and basic categories. It intentionally ignores common heavy paths such as `node_modules`, build output, coverage, lockfiles, and `.frontload`.

### 2. Generate a task dossier

```bash
frontload dossier "Add month-by-month navigation to Story screen" --repo . --budget 12000
```

A dossier includes:

- task description
- requested context budget
- ranking confidence notes
- likely test commands
- most relevant files with scores and reasons
- suggested read order
- dependency notes

If the ranking confidence section says the result is noisy, search with more concrete terms:

```bash
frontload search "StoryViewModel viewedMonth YearMonth navigation" --repo . --limit 12
```

### 3. Read only what is needed

```bash
frontload read app/src/main/java/com/example/StoryViewModel.kt --repo . --budget 4000 --query viewedMonth
```

Budgeted reads:

- return line-numbered output
- cap the response to the requested character budget
- include relevant imports, symbols, and query matches when truncating
- redact common secret patterns
- suggest next files from import edges when available

### 4. Run commands through summaries

```bash
frontload run --repo . --kind test -- pnpm test
frontload run --repo . --kind typecheck -- pnpm tsc --noEmit
frontload run --repo . --kind test -- ./gradlew testDebugUnitTest
```

The full raw log is stored under `.frontload/logs/`. The agent sees a compact summary with exit code, duration, preserved findings, and the log path.

`frontload` allows commands from `frontload.config.json` and also discovers common safe project commands from:

- `package.json` scripts
- Gradle metadata such as `gradlew` or `build.gradle.kts`
- `Cargo.toml`

Use `--allow-unconfigured` only when you intentionally want to run a command outside those allowlists.

### 5. Inspect diffs and cost

```bash
frontload diff --repo .
frontload budget --repo .
frontload compare-cost --repo . --base HEAD~1 --head HEAD
```

`compare-cost` reports:

- full changed-file baseline tokens
- patch baseline tokens
- logged `frontload` output tokens
- savings versus full-file and patch baselines
- changed files with category and size data

This is the command to use when you want to prove whether the workflow actually reduced context burden.

## CLI Reference

### `init`

```bash
frontload init
frontload init --agents codex,claude
frontload init --agents none
frontload init --force
```

Creates starter files and the onboarded `.frontload/` state directory in the
current repository:

- `frontload.config.json`
- `AGENTS.md`
- `.frontload/`

Without `--force`, existing files are left untouched.

`init` then asks which agent adapters to configure:

- `codex`: merges `mcp_servers.frontload` into `~/.codex/config.toml`, merges Frontload PreToolUse and PostToolUse Bash hooks into `~/.codex/hooks.json`, and copies the Frontload skill to `~/.codex/skills/frontload`; open `/hooks` once to review and trust the hooks.
- `claude`: merges `mcpServers.frontload` into project `.mcp.json` by default, or `~/.claude.json` with `--scope global`, writes Frontload PreToolUse and PostToolUse hooks to the matching Claude settings file, and copies the Frontload skill to `~/.claude/skills/frontload`.

If `frontload` is not already installed globally, `init` prompts before running
the package-manager-specific global install command. Restart the editor after
init completes; MCP clients load server config at startup.

### `doctor`

```bash
frontload doctor --repo .
```

Checks basic environment and state directory writability.

### `index`

```bash
frontload index --repo .
```

Scans the repo and writes `.frontload/index.json`.

### `dossier`

```bash
frontload dossier "task description" --repo . --format markdown --budget 12000
```

Generates a task-focused Markdown dossier. The `--format` flag currently accepts `markdown`; structured data is used internally by MCP tools.

### `search`

```bash
frontload search "tooltip reconnect" --repo . --limit 10
```

Ranks indexed files for a query.

### `read`

```bash
frontload read src/chart/ChartTooltip.tsx --repo . --budget 4000
frontload read src/chart/ChartTooltip.tsx --repo . --budget 4000 --query reconnect
```

Reads a file with a bounded response. Large files are excerpted.

### `run`

```bash
frontload run --repo . --kind test -- pnpm test
frontload run --repo . --kind typecheck -- pnpm tsc --noEmit
frontload run --repo . --kind lint -- pnpm lint
```

Runs a configured or discovered command and summarizes output. Kinds are `test`, `typecheck`, `lint`, or `generic`.

### `diff`

```bash
frontload diff --repo .
frontload diff --repo . --staged
```

Summarizes changed files, categories, and risky changes without dumping the full patch.

### `compare-cost`

```bash
frontload compare-cost --repo . --base HEAD~1 --head HEAD
```

Compares logged `frontload` context against raw changed-file and patch baselines for a git range.

### `budget`

```bash
frontload budget --repo .
```

Reports logged operations, estimated token output, largest operations, and the last 20 events.

Token estimates use `chars / 4`. Treat them as directional, not billing-grade.

### `validate-plugins`

```bash
frontload validate-plugins --repo .
```

Validates the bundled Codex and Claude plugin packages with the project's TypeScript/Zod schemas. This checks manifests, hooks, and skill files without requiring Python.

### `mcp`

```bash
frontload mcp --repo .
```

Starts the MCP stdio server for the repo.

### `proof`

```bash
pnpm proof
```

Builds the project, runs tests and e2e checks, runs the fixture demo, and writes proof artifacts under `proof/`.

## Configuration

`frontload.config.json` controls indexing, budgets, command allowlists, and security defaults.

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
    "**/*.lock",
    ".frontload/**"
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
      "pnpm tsc",
      "npm test",
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

Defaults are defined in `src/config/config.ts`.

## Codex and MCP

`frontload` can be used directly by Codex through MCP.

Build the project:

```bash
pnpm build
```

Start the MCP server for a repo:

```bash
frontload mcp --repo /path/to/repo
```

The MCP server exposes:

- `fl_policy`
- `fl_repo_index`
- `fl_repo_dossier`
- `fl_search`
- `fl_read_budgeted`
- `fl_run_summary`
- `fl_git_diff_summary`
- `fl_budget_report`
- `fl_local_scout`

See:

- `docs/codex-setup.md`
- `docs/mcp-tools.md`
- `skills/frontload/SKILL.md`

## Plugins

This repository includes plugin adapter packages for both Codex and Claude Code:

```text
plugins/
  codex/
    .codex-plugin/plugin.json
    hooks/hooks.json
    skills/frontload/SKILL.md
  claude/
    .claude-plugin/plugin.json
    hooks/hooks.json
    skills/frontload/SKILL.md
```

The shared implementation lives in the CLI runtime. Plugin folders carry skills
and hook templates only; MCP registration is written by `frontload init` into
the real editor config files.

Recommended setup path:

```bash
npx frontload init
```

The init command asks whether to configure Codex, Claude Code, both, or neither.
It writes each editor's real MCP and hook configuration. This is the supported
user setup path for agent adapters.

Host enforcement follows the hooks each editor currently exposes:

| Host | PreToolUse | PostToolUse | Current limitation |
| --- | --- | --- | --- |
| Claude Code | Bounds Read and rewrites Bash | Bounds Grep and Glob output | Structured output is compacted without changing the native response schema |
| Codex | Rewrites interceptable Bash | Bounds interceptable Bash output | No native Read/Grep/Glob hook parity |

Codex command hooks require one review through `/hooks`. All Frontload hook
handlers are inert unless the active repository contains `.frontload`.

For local development from this repository, build first and point hosts at the
repo plugin folders:

```bash
pnpm build
claude --plugin-dir ./plugins/claude
```

Validate both bundled plugins with:

```bash
frontload validate-plugins --repo .
```

## Ranking Policy

Dossier and search ranking use repository-local heuristics:

- path, basename, symbol, import/export, dependency-edge, and related-test matches
- generic task terms are ignored or downweighted
- docs are downweighted unless the task appears documentation-focused
- generated, fixture, snapshot, and lockfile paths are downweighted
- large files are downweighted unless other signals are strong
- the dossier includes ranking confidence notes when top results look noisy

This is deliberately transparent. The point is not to pretend to understand code semantically; the point is to get the agent to a smaller, defensible starting set.

## Security

`frontload` is local-first:

- no runtime LLM API calls
- no source upload
- local JSON/JSONL state only
- command logs stay in `.frontload/logs/`
- common token, password, secret, and API key patterns are redacted from budgeted reads and command summaries

You are still responsible for command allowlists. Do not configure destructive commands as allowed unless you really want agents to run them.

## Limitations

- Token counts are estimates, not exact tokenizer counts.
- Ranking is lexical and heuristic.
- Kotlin and Markdown symbol extraction is simpler than TypeScript/JavaScript extraction.
- `compare-cost` relies on git history and current `.frontload/events.jsonl`.
- Command summaries preserve common TypeScript and test failures, but parsers are intentionally conservative.
- Local scout is an extension point and is disabled by default.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm e2e
pnpm proof
```

Useful files:

- `src/cli/index.ts`: CLI entrypoint
- `src/indexer/indexer.ts`: repo indexer
- `src/dossier/dossier.ts`: ranking and dossier generation
- `src/commands/read.ts`: budgeted file reads
- `src/commands/run.ts`: command summaries
- `src/diff/diff.ts`: diff and cost comparison
- `src/mcp/server.ts`: MCP server
- `tests/unit/`: unit coverage
- `tests/e2e/`: proof workflow coverage

## Proof

The repository includes proof artifacts under `proof/`, including a token-cost trial against two real apps:

- `proof/strimma-springa-token-cost-report.md`
- `proof/raw-vs-summary.json`
- `proof/sample-dossier.md`
- `proof/mcp-transcript.jsonl`

Regenerate proof artifacts with:

```bash
pnpm proof
```
