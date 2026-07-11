# How Frontload Works

Frontload is local-first. It does not upload source code or call an LLM API at
runtime.

When you run `npx frontload init`, Frontload creates project state in
`.frontload/` and can configure supported agents (Codex, Claude Code, opencode)
to use its MCP server. Codex and Claude Code also install command hooks;
opencode is MCP plus the Frontload skill in this phase (a hook gate is planned).

The workflow has four local parts:

- Indexer: scans supported files and writes `.frontload/index.json`.
- Dossier generator: ranks files for a task using lexical matches, symbols, dependency edges, tests, and path clues.
- Budgeted tools: bounded reads, summarized commands, compact diffs, and budget reports.
- MCP server: exposes the same capabilities to supported agents over stdio.

Command logs stay under `.frontload/logs/`. Budget and event metadata stay in
`.frontload/events.jsonl`. When Frontload creates generated state in a Git
repository, it adds `.frontload/` to the repository's local `.git/info/exclude`
so generated state does not dirty `git status`.
