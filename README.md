# frontload

`frontload` is a local-first context and cost gateway for AI coding agents.

It helps agents start from a compact repo map, read only the file windows they
need, summarize command output, and track how much model-visible context was
saved. Source code and command logs stay on your machine. Frontload does not
call an LLM API.

## Quick Start

Run this from the repository where you want agents to use Frontload:

```bash
npx frontload init
```

`init` creates the project state Frontload needs:

- `frontload.config.json`
- `.frontload/`

It also asks which agent integrations to configure. Choose Codex, Claude Code,
opencode, any combination, or none. For automation, use one of these:

```bash
npx frontload init --agents codex
npx frontload init --agents claude
npx frontload init --agents opencode
npx frontload init --agents all
npx frontload init --agents none
```

If `frontload` is not already available on your `PATH`, `init` prompts before
installing the package globally with npm. Restart your editor after init
completes; MCP clients load server configuration at startup.

Frontload stores repo-local state under `.frontload/` and adds `.frontload/` to
the repository's local `.git/info/exclude` when it writes generated state. You
can still add `.frontload/` to shared `.gitignore` rules if your team prefers
that convention. `frontload init` prints this local-exclude behavior, and
`frontload doctor` reports whether the local exclude rule is present and whether
it had to repair the rule during the check. If you use Codex, also ignore
`.codex/` unless your team intentionally wants to share project-local Codex
config; Frontload writes an absolute repo path there.

Run `npx frontload init` separately in each repository. Frontload writes
repo-local MCP config where the agent supports it, so initializing another repo
does not replace the first repo's MCP entry.

## What You Get

Frontload gives coding agents a smaller, more deliberate workflow behind the
normal agent experience:

```text
task -> MCP dossier/search -> budgeted reads -> summarized commands -> budget report
```

The main capabilities are:

- repo indexing with paths, symbols, imports, and file metadata
- task dossiers that rank likely files and suggested tests
- budgeted file reads with redaction and paging hints
- summarized test, lint, typecheck, and build output with full logs kept locally
- compact git diff summaries
- budget reports showing measured context savings
- MCP tools and skills so supported agents can use these capabilities without a
  manual CLI routine

## Requirements

- Node.js 20+
- git
- a package manager available through `npx`, `npm`, `pnpm`, or `yarn`

## Daily Workflow

### 1. Initialize the Repo Once

```bash
npx frontload init
```

Use `--agents` when you do not want the interactive checkbox prompt:

```bash
npx frontload init --agents codex
```

For Codex, open `/hooks` once after installation to review and approve the
Frontload command hooks. For Claude Code, choose whether MCP config should be
written to the project or global config when prompted.

Restart your editor so it loads the MCP server. From that point, use Codex or
Claude Code the way you normally do. The installed Frontload skill tells the
agent to start broad repo work with MCP dossiers and search, read bounded file
windows instead of dumping whole files, run noisy commands through summaries,
and inspect compact diffs before reviewing changes.

You do not need to run `frontload index`, `frontload dossier`, or
`frontload search` as a daily setup step. Dossier and search calls build the
index when it is missing and refresh changed files automatically.

### 2. Let the Agent Use Frontload

After setup, a typical agent turn looks like this from the agent's side:

1. Call `fl_repo_dossier` for the task.
2. Use `fl_search` when the dossier needs more concrete symbols, filenames, or
   domain terms.
3. Use `fl_read_budgeted` for the specific file windows it needs.
4. Run tests, typechecks, lint, and build commands through `fl_run_summary`.
5. Use `fl_git_diff_summary` and `fl_budget_report` before wrapping up.

The user-facing workflow is still just normal agent work: describe the task,
review the changes, and rely on Frontload to keep the agent's context smaller
and more focused.

## CLI Workflow

The CLI commands remain useful for debugging, automation, unsupported agents,
or checking what the MCP tools return. They are the manual equivalent of the
agent-first workflow above.

### Refresh the Repo Index

```bash
frontload index --repo .
```

The index records supported files, symbols, imports, dependency edges, sizes,
and basic categories. It scans only configured literal file extensions and
ignores common heavy paths such as `node_modules`, build output, coverage,
lockfiles, agent worktrees, framework caches, and `.frontload`. The MCP dossier
and search tools call the same indexing logic automatically when needed.

### Generate a Task Dossier

```bash
frontload dossier "Fix stale chart tooltip value after sensor reconnect" --repo .
```

A dossier gives the agent a compact starting point:

- likely files, with scores and reasons
- suggested read order
- likely test commands
- dependency notes
- ranking confidence notes

If the ranking confidence section says results are noisy, search with concrete
domain words, filenames, or symbols:

```bash
frontload search "StoryViewModel viewedMonth YearMonth navigation" --repo . --limit 12
```

### Read Only What Is Needed

```bash
frontload read src/chart/ChartTooltip.tsx --repo . --budget 4000
frontload read src/chart/ChartTooltip.tsx --repo . --budget 4000 --query reconnect
```

Budgeted reads return bounded excerpts, line numbers, redaction for common
secret patterns, and paging hints for larger files.

- return a raw, contiguous `excerpt` that is safe to use for edits when `editSafe` is true
- include `numberedExcerpt` for line references when it fits the response budget
- cap the excerpt and keep the visible response bounded
- include relevant imports, symbols, and query matches when truncating
- redact common secret patterns
- suggest next files from import edges when available

### Run Commands Through Summaries

```bash
frontload run --repo . --kind test -- pnpm test
frontload run --repo . --kind typecheck -- pnpm tsc --noEmit
frontload run --repo . --kind lint -- pnpm lint
```

The full raw log is stored under `.frontload/logs/`. The agent sees a compact
summary with exit code, duration, preserved failures, and the log path.

`frontload run` propagates the wrapped command's exit code to the Frontload
process, so CI, shell scripts, and command chaining see the real failure.

When package-manager or framework output points at common setup races, the
summary includes a targeted hint. For example, pnpm's
`ERR_PNPM_IGNORED_BUILDS` explains that dependency build scripts were blocked
before the requested command ran, and TypeScript `TS6053` output for
`.next/types` notes that Next.js generated types can be transient while a build
is running.

Frontload allows commands from `frontload.config.json` and discovers common safe
project commands from `package.json`, Gradle metadata, and `Cargo.toml`. Use
`--allow-unconfigured` only for a trusted one-off local command.

### Inspect Diff and Cost

```bash
frontload diff --repo .
frontload diff --repo . --tracked-only
frontload budget --repo .
frontload compare-cost --repo . --base HEAD~1 --head HEAD
```

`frontload diff` summarizes changed files without dumping the full patch. By
default it includes untracked files in the file list and notes that their
content is omitted from the diff body. Use `--tracked-only` for the old
tracked-file-only behavior.

`frontload budget` reports measured savings for logged operations. Small outputs
can show negative savings when the structured wrapper is larger than the raw
baseline; the report calls that out as normal metadata overhead.
`frontload compare-cost` compares logged Frontload output against raw changed
files and patch baselines for a git range.

## Agent Setup

`npx frontload init` is the supported setup path for agent integrations.

### Codex

```bash
npx frontload init --agents codex
```

Init writes the Frontload MCP server to project `.codex/config.toml`, copies the
Frontload skill to `~/.codex/skills/frontload`, and merges Frontload command
hooks into `~/.codex/hooks.json`.

Open `/hooks` once after installation to approve the command hooks. The hooks
are stored globally, but their command first checks for `.frontload/` and exits
before starting `frontload` outside initialized repositories.

Codex hook coverage follows the hook runtime Codex exposes: Frontload rewrites
supported Bash calls before execution and bounds oversized Bash output after
execution. Codex does not currently expose Claude-equivalent native
Read/Grep/Glob hook names.

See [docs/codex-setup.md](docs/codex-setup.md) for details.

### Claude Code

```bash
npx frontload init --agents claude
```

Init writes the Frontload MCP entry to project `.mcp.json` by default, or to
`~/.claude.json` with `--scope global`. It also writes Frontload hooks to the
matching Claude settings file and copies the skill to
`~/.claude/skills/frontload`.

Claude hooks can bound native reads, rewrite broad or configured shell commands,
and bound noisy Grep/Glob output. The hooks apply only in repositories that
contain `.frontload/`.

### opencode

```bash
npx frontload init --agents opencode
```

Init writes the Frontload MCP entry to project `opencode.json` by default, or to
`~/.config/opencode/opencode.json` with `--scope global`. If `opencode.jsonc`
already exists, init writes to that instead and preserves comments. It also
copies the Frontload skill to `~/.config/opencode/skills/frontload`.

Restart opencode after init so it loads the MCP server and skill. opencode
discovers the skill automatically from `~/.config/opencode/skills/`.

Context savings come from the Frontload skill guiding the agent toward MCP
tools, the budgeted responses those tools return, and the gate plugin that
rewrites broad shell commands and compacts oversized tool output. Init writes
the gate plugin wrapper to `~/.config/opencode/plugins/frontload-gate.js`;
the wrapper delegates to Frontload's shared gate adapter and can rediscover the
installed package from `PATH`.

If your team shares `opencode.json` in git, either add it to `.gitignore` or use
`--scope global`, since Frontload pins an absolute repo path in the MCP entry.

## Troubleshooting

Run doctor from the initialized repo:

```bash
frontload doctor --repo .
```

Doctor checks local state, the installed `frontload` command, the active Codex
MCP config scope, and whether the configured MCP command can launch and answer
`fl_policy`. If doctor passes but a currently open Codex session still reports
`Transport closed`, restart Codex so it reloads the MCP process. If doctor
reports `legacyGlobalConflict`, an older global `~/.codex/config.toml`
Frontload entry points at another repo; the project `.codex/config.toml` is
preferred, and the legacy global entry can be removed once you no longer need
it. If that global entry points at a missing absolute path or a stale path
containing only `.frontload` state, run `frontload upgrade --repo .` from the
repo you want Codex to use.

## CLI Reference

### `init`

```bash
frontload init
frontload init --agents codex,claude
frontload init --agents none
frontload init --force
frontload init --yes
```

Creates starter files and `.frontload/` state in the current repository.
Without `--force`, existing files are left untouched.

`init` then asks which agent adapters to configure with a checkbox prompt. MCP
entries created by init pin `--repo` to the absolute path of the initialized
repository so editor launch directories do not change which repo Frontload
serves:

- `codex`: writes a repo-specific `mcp_servers.frontload_<repo>_<hash>` entry into project `.codex/config.toml`, merges guarded Frontload PreToolUse and PostToolUse Bash hooks into `~/.codex/hooks.json`, and copies the Frontload skill to `~/.codex/skills/frontload`; open `/hooks` once to review and approve the hooks.
- `claude`: merges `mcpServers.frontload` into project `.mcp.json` by default, or `~/.claude.json` with `--scope global`, writes Frontload PreToolUse and PostToolUse hooks to the matching Claude settings file, and copies the Frontload skill to `~/.claude/skills/frontload`.
- `opencode`: writes `mcp.frontload` into project `opencode.json` (or existing `opencode.jsonc`) by default, or `~/.config/opencode/opencode.json` with `--scope global`, copies the Frontload skill to `~/.config/opencode/skills/frontload`, and writes a gate plugin wrapper to `~/.config/opencode/plugins/frontload-gate.js`.

Gate-rewritten run, search, and read commands resolve the Git worktree when the
command executes, so linked worktrees keep their state and command logs separate
even when a host hook does not provide the command working directory.

If `frontload` is not already installed globally, `init` prompts before running
`npm install -g frontload`. Use `--yes` to approve the global install prompt in
automation. Restart the editor after init completes; MCP clients load server
config at startup.

### `upgrade`

```bash
frontload upgrade
frontload upgrade --yes
frontload upgrade --repo .
```

Updates the global `frontload` package, then refreshes only agent integrations
that already contain a Frontload MCP entry. It does not create starter project
files or configure new agents. If an existing managed MCP entry points at a
missing path or a stale path containing only `.frontload` state, upgrade repins
it to `--repo`.

After a release, you can also run:

```bash
npx frontload@latest upgrade
```

### `doctor`

```bash
frontload doctor --repo .
frontload doctor --repo . --dogfood
```

Checks the local environment, installed `frontload` command, Frontload state
directory, active Codex MCP config, and whether the configured MCP command can
launch and answer a health request. It also reports whether generated
`.frontload/` state is ignored locally through `.git/info/exclude`, including
whether doctor repaired that rule during the check.
Add `--dogfood` to fail when the active Codex setup is not using the regular
installed `frontload` command for the requested repo. `--home <dir>` points
doctor at an alternate home directory for agent configuration checks.

### `index`

```bash
frontload index --repo .
```

Scans the repo and writes `.frontload/index.json`. The `stats.ignoredCount`
field counts files that matched the configured index extensions but were skipped
by index limits, such as `maxFileBytes`; it does not require a repo-wide count
of every unsupported file type.

### `dossier`

```bash
frontload dossier "task description" --repo . --format markdown --budget 6000 --max-files 12
```

Generates a task-focused Markdown dossier. The `--format` flag currently accepts
`markdown`; `--max-files` limits the ranked file list. Structured data is used
internally by MCP tools.

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

Runs a configured or discovered command and summarizes output. Kinds are
`test`, `typecheck`, `lint`, or `generic`. The process exit code mirrors the
wrapped command's exit code.

### `diff`

```bash
frontload diff --repo .
frontload diff --repo . --staged
frontload diff --repo . --tracked-only
```

Summarizes changed files, categories, and risky changes without dumping the full
patch. Unstaged summaries include untracked files by default and note that their
content is omitted from the diff body. Use `--tracked-only` to omit untracked
files.

### `compare-cost`

```bash
frontload compare-cost --repo . --base HEAD~1 --head HEAD
```

Compares logged Frontload context against raw changed-file and patch baselines
for a git range.

### `budget`

```bash
frontload budget --repo .
```

Reports logged operations, exact measured baseline/output bytes, signed net
savings, and unmeasured operation counts. Oversized reports keep totals and as
many per-operation aggregates as fit while omitting largest/recent event
details to stay under the configured tool output cap. Token estimates use
`chars / 4`; treat them as directional, not billing-grade.

### `proof`

```bash
frontload proof --repo .
```

Generates local proof artifacts under `.frontload/proof/`, including the test
report, MCP transcript placeholder, and raw-vs-summary comparison. These files
are generated evidence and follow the same local exclude behavior as the rest of
`.frontload/`; keep tracked `proof/` files for stable, hand-authored reports
only.

### `mcp`

```bash
frontload mcp --repo .
```

Starts the MCP stdio server for the repo. Most users get this configured through
`frontload init`.

## Configuration

`frontload.config.json` controls indexing, budgets, command allowlists, security
defaults, and hook enforcement.

Example:

```json
{
  "repoRoot": ".",
  "ignore": [
    "node_modules/**",
    "**/node_modules/**",
    ".git/**",
    "**/.git/**",
    "dist/**",
    "**/dist/**",
    "build/**",
    "**/build/**",
    "coverage/**",
    "**/coverage/**",
    ".next/**",
    "**/.next/**",
    "out/**",
    "**/out/**",
    ".turbo/**",
    "**/.turbo/**",
    ".cache/**",
    "**/.cache/**",
    ".expo/**",
    "**/.expo/**",
    ".Codex/**",
    "**/.Codex/**",
    ".codex/**",
    "**/.codex/**",
    ".gradle/**",
    "**/.gradle/**",
    "Pods/**",
    "**/Pods/**",
    "**/.env*",
    "**/*.local.md",
    "**/*.lock",
    "*.tsbuildinfo",
    "**/*.tsbuildinfo",
    ".frontload/**",
    "**/.frontload/**"
  ],
  "index": {
    "maxFileBytes": 300000,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".kt", ".kts"]
  },
  "budgets": {
    "defaultDossierChars": 6000,
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
  },
  "gate": {
    "enabled": true,
    "rewriteCommands": true,
    "blockBroadShell": true,
    "blockNoisyReads": true,
    "maxReadLines": 200
  }
}
```

`index.extensions` values are treated as literal extensions. A leading dot is
optional (`"json"` is normalized to `".json"`), and glob expressions are not
expanded.

## Ranking Policy

Dossier and search ranking use repository-local heuristics:

- path, basename, symbol, import/export, dependency-edge, and related-test matches
- generic task terms are ignored or downweighted
- docs are downweighted unless the task appears documentation-focused
- generated, fixture, snapshot, and lockfile paths are downweighted
- large files are downweighted unless other signals are strong
- dossiers include ranking confidence notes when top results look noisy

The ranking is intentionally transparent. It is a smaller starting set for the
agent, not a claim of semantic understanding.

## Security

Frontload is local-first:

- no runtime LLM API calls
- no source upload
- local JSON/JSONL state only
- command logs stay in `.frontload/logs/`
- generated `.frontload/` state is added to local Git exclude rules when written
- common token, password, secret, and API key patterns are redacted from
  budgeted reads and command summaries

You are still responsible for command allowlists. Do not configure destructive
commands as allowed unless you really want agents to run them.

See [docs/security.md](docs/security.md) for a shorter security summary.

## Troubleshooting

- MCP server missing after init: restart the editor and confirm
  `frontload --version` works in your shell.
- Command is not allowed: add a safe prefix to `commands.allowed`, or use
  `--allow-unconfigured` for a trusted one-off local run.
- Dossier is empty: use more concrete file, domain, symbol, or error words. If
  it stays empty, run `frontload doctor --repo .` to verify setup.
- Codex config key rejected: keep the MCP `command` and `args`, then remove the
  rejected optional key.

See [docs/troubleshooting.md](docs/troubleshooting.md) for more detail.

## Limitations

- Token counts are estimates, not exact tokenizer counts.
- Ranking is lexical and heuristic.
- Kotlin and Markdown symbol extraction is simpler than TypeScript/JavaScript
  extraction.
- `compare-cost` relies on git history and current `.frontload/events.jsonl`.
- Savings are reported only when Frontload observes an exact baseline; other
  operations are labeled unmeasured.
- Command summaries preserve common TypeScript and test failures, but parsers
  are intentionally conservative.
- Local scout is an extension point and is disabled by default.
