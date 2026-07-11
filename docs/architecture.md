# How Frontload Works

Frontload is local-first. It does not upload source code or call an LLM API at
runtime.

When you run `npx frontload init`, Frontload creates project state in
`.frontload/` and can configure supported agents (Codex, Claude Code, opencode)
to use its MCP server and command hooks. Codex and Claude Code use declarative
PreToolUse/PostToolUse hooks; opencode uses a JS plugin gate
(`frontload-gate.js`) installed to `~/.config/opencode/plugins/`. These host
entrypoints adapt native hook payloads into the shared gate runtime, so policy
decisions, canonical config loading, command construction, output compaction,
and budget event accounting live in one implementation.

The workflow has four local parts:

- Indexer: scans supported files and writes `.frontload/index.json`.
- Dossier generator: ranks files for a task using lexical matches, symbols, dependency edges, tests, and path clues.
- Budgeted tools: bounded reads, summarized commands, compact diffs, and budget reports.
- MCP server: exposes the same capabilities to supported agents over stdio.

Command logs stay under `.frontload/logs/`. Budget and event metadata stay in
`.frontload/events.jsonl`. When Frontload creates generated state in a Git
repository, it adds `.frontload/` to the repository's local `.git/info/exclude`
so generated state does not dirty `git status`.
