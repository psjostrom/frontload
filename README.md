# agent-budget

`agent-budget` is a local-first context and cost gateway for coding agents.

It helps an expensive coding agent work from compact, relevant context instead of repeatedly reading the whole repository, dumping raw test logs into chat, and rediscovering the same files on every loop.

The core idea is simple:

```text
repo index -> task dossier -> budgeted reads -> summarized commands -> budget report
```

Source code stays local. `agent-budget` does not call an LLM API.

## Why

Agentic coding gets expensive when the agent:

- explores a repo from scratch every turn
- reads large source, fixture, generated, or docs files when only a small excerpt is useful
- pastes raw test, typecheck, build, or lint output into model context
- repeats repair loops without seeing how much context each loop costs
- treats docs, tests, generated files, and source files as equally relevant

`agent-budget` gives the agent smaller and more deliberate inputs:

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
agent-budget
```

## Quick Start

In a target repository:

```bash
npx agent-budget init --agents all
agent-budget doctor
agent-budget index --repo .
agent-budget dossier "Fix stale chart tooltip value after sensor reconnect" --repo .
agent-budget read src/chart/ChartTooltip.tsx --repo . --budget 4000
agent-budget run --repo . --kind test -- pnpm test
agent-budget budget --repo .
```

If you already installed the package globally, use `agent-budget init --agents all`.
Use `--agents codex`, `--agents claude`, or `--agents none` to control which
agent adapters are installed.

Local state is written to `.agent-budget/` in the target repo:

```text
.agent-budget/
  index.json
  events.jsonl
  logs/
  cache/
```

Add `.agent-budget/` to the target repo's `.gitignore`.

## Daily Workflow

### 1. Index the repo

```bash
agent-budget index --repo .
```

The index records supported files, symbols, imports, dependency edges, sizes, and basic categories. It intentionally ignores common heavy paths such as `node_modules`, build output, coverage, lockfiles, and `.agent-budget`.

### 2. Generate a task dossier

```bash
agent-budget dossier "Add month-by-month navigation to Story screen" --repo . --budget 12000
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
agent-budget search "StoryViewModel viewedMonth YearMonth navigation" --repo . --limit 12
```

### 3. Read only what is needed

```bash
agent-budget read app/src/main/java/com/example/StoryViewModel.kt --repo . --budget 4000 --query viewedMonth
```

Budgeted reads:

- return line-numbered output
- cap the response to the requested character budget
- include relevant imports, symbols, and query matches when truncating
- redact common secret patterns
- suggest next files from import edges when available

### 4. Run commands through summaries

```bash
agent-budget run --repo . --kind test -- pnpm test
agent-budget run --repo . --kind typecheck -- pnpm tsc --noEmit
agent-budget run --repo . --kind test -- ./gradlew testDebugUnitTest
```

The full raw log is stored under `.agent-budget/logs/`. The agent sees a compact summary with exit code, duration, preserved findings, and the log path.

`agent-budget` allows commands from `agent-budget.config.json` and also discovers common safe project commands from:

- `package.json` scripts
- Gradle metadata such as `gradlew` or `build.gradle.kts`
- `Cargo.toml`

Use `--allow-unconfigured` only when you intentionally want to run a command outside those allowlists.

### 5. Inspect diffs and cost

```bash
agent-budget diff --repo .
agent-budget budget --repo .
agent-budget compare-cost --repo . --base HEAD~1 --head HEAD
```

`compare-cost` reports:

- full changed-file baseline tokens
- patch baseline tokens
- logged `agent-budget` output tokens
- savings versus full-file and patch baselines
- changed files with category and size data

This is the command to use when you want to prove whether the workflow actually reduced context burden.

## CLI Reference

### `init`

```bash
agent-budget init
agent-budget init --agents all
agent-budget init --agents codex,claude
agent-budget init --force
```

Creates starter files and the onboarded `.agent-budget/` state directory in the
current repository:

- `agent-budget.config.json`
- `AGENTS.md`
- `codex/config.toml`
- `.agent-budget/`

Without `--force`, existing files are left untouched.

When `--agents` is set, `init` also installs agent adapters:

- `codex`: copies the Codex plugin adapter to `~/plugins/agent-budget` and
  adds/updates `~/.agents/plugins/marketplace.json`.
- `claude`: copies the Claude Code plugin adapter to
  `~/.claude/plugins/agent-budget`.

### `install`

```bash
agent-budget install codex
agent-budget install claude
agent-budget install all
```

Installs or updates agent adapters without changing the current repository.
Adapters are thin wrappers around the installed `agent-budget` CLI. Set
`AGENT_BUDGET_CLI=/absolute/path/to/agent-budget` if your agent host cannot find
the binary on `PATH`.

### `doctor`

```bash
agent-budget doctor --repo .
```

Checks basic environment and state directory writability.

### `index`

```bash
agent-budget index --repo .
```

Scans the repo and writes `.agent-budget/index.json`.

### `dossier`

```bash
agent-budget dossier "task description" --repo . --format markdown --budget 12000
```

Generates a task-focused Markdown dossier. The `--format` flag currently accepts `markdown`; structured data is used internally by MCP tools.

### `search`

```bash
agent-budget search "tooltip reconnect" --repo . --limit 10
```

Ranks indexed files for a query.

### `read`

```bash
agent-budget read src/chart/ChartTooltip.tsx --repo . --budget 4000
agent-budget read src/chart/ChartTooltip.tsx --repo . --budget 4000 --query reconnect
```

Reads a file with a bounded response. Large files are excerpted.

### `run`

```bash
agent-budget run --repo . --kind test -- pnpm test
agent-budget run --repo . --kind typecheck -- pnpm tsc --noEmit
agent-budget run --repo . --kind lint -- pnpm lint
```

Runs a configured or discovered command and summarizes output. Kinds are `test`, `typecheck`, `lint`, or `generic`.

### `diff`

```bash
agent-budget diff --repo .
agent-budget diff --repo . --staged
```

Summarizes changed files, categories, and risky changes without dumping the full patch.

### `compare-cost`

```bash
agent-budget compare-cost --repo . --base HEAD~1 --head HEAD
```

Compares logged `agent-budget` context against raw changed-file and patch baselines for a git range.

### `budget`

```bash
agent-budget budget --repo .
```

Reports logged operations, estimated token output, largest operations, and the last 20 events.

Token estimates use `chars / 4`. Treat them as directional, not billing-grade.

### `validate-plugins`

```bash
agent-budget validate-plugins --repo .
```

Validates the bundled Codex and Claude plugin packages with the project's TypeScript/Zod schemas. This checks manifests, MCP config, launchers, executable bits, and skill files without requiring Python.

### `mcp`

```bash
agent-budget mcp --repo .
```

Starts the MCP stdio server for the repo.

### `proof`

```bash
pnpm proof
```

Builds the project, runs tests and e2e checks, runs the fixture demo, and writes proof artifacts under `proof/`.

## Configuration

`agent-budget.config.json` controls indexing, budgets, command allowlists, and security defaults.

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
    ".agent-budget/**"
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

`agent-budget` can be used directly by Codex through MCP.

Build the project:

```bash
pnpm build
```

Start the MCP server for a repo:

```bash
agent-budget mcp --repo /path/to/repo
```

The MCP server exposes:

- `abg_policy`
- `abg_repo_index`
- `abg_repo_dossier`
- `abg_search`
- `abg_read_budgeted`
- `abg_run_summary`
- `abg_git_diff_summary`
- `abg_budget_report`
- `abg_local_scout`

See:

- `docs/codex-setup.md`
- `docs/mcp-tools.md`
- `codex/config.example.toml`
- `skills/agent-budget/SKILL.md`

## Plugins

This repository includes plugin adapter packages for both Codex and Claude Code:

```text
plugins/
  codex/
    .codex-plugin/plugin.json
    .mcp.json
    bin/agent-budget-gate
    bin/agent-budget-mcp
    hooks/hooks.json
    skills/agent-budget/SKILL.md
  claude/
    .claude-plugin/plugin.json
    .mcp.json
    bin/agent-budget-gate
    bin/agent-budget-mcp
    hooks/hooks.json
    skills/agent-budget/SKILL.md
```

The shared implementation still lives in the CLI runtime. Each plugin is a thin
adapter that launches the installed `agent-budget` MCP server and hook gate.

Recommended install path:

```bash
npx agent-budget init --agents all
```

Codex uses the personal marketplace written to
`~/.agents/plugins/marketplace.json`; restart Codex, open `/plugins`, choose the
Personal marketplace, and install or enable Agent Budget.

Claude Code local test after `agent-budget install claude`:

```bash
claude --plugin-dir ~/.claude/plugins/agent-budget
```

For local development from this repository, build first and point hosts at the
repo plugin folders:

```bash
pnpm build
claude --plugin-dir ./plugins/claude
```

The repo also includes `.agents/plugins/marketplace.json` for Codex marketplace
development against `./plugins/codex`.

Validate both bundled plugins with:

```bash
agent-budget validate-plugins --repo .
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

`agent-budget` is local-first:

- no runtime LLM API calls
- no source upload
- local JSON/JSONL state only
- command logs stay in `.agent-budget/logs/`
- common token, password, secret, and API key patterns are redacted from budgeted reads and command summaries

You are still responsible for command allowlists. Do not configure destructive commands as allowed unless you really want agents to run them.

## Limitations

- Token counts are estimates, not exact tokenizer counts.
- Ranking is lexical and heuristic.
- Kotlin and Markdown symbol extraction is simpler than TypeScript/JavaScript extraction.
- `compare-cost` relies on git history and current `.agent-budget/events.jsonl`.
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
