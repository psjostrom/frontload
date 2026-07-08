---
description: Use when working in a code repository to reduce context cost with Frontload MCP tools, task dossiers, budgeted reads, summarized command output, and token-cost reports.
---

# Frontload

Use Frontload before broad repository exploration.

Default workflow:

1. Start with the Frontload repo dossier tool for the current task.
2. Search the index when the dossier is noisy or when you need concrete symbols.
3. Read contiguous file windows through budgeted reads instead of raw full-file reads. Prefer the raw `excerpt` for edits when `editSafe` is true, and use `numberedExcerpt` only for line references when it is present.
4. Run tests, typechecks, lint, and build commands through summarized command tools.
5. Use diff summaries before reviewing changes.
6. Check the budget report before repeating repair loops.

Do not ask the user to run `frontload index` before normal work; the repo dossier and search tools build or refresh the index automatically.

Avoid raw `find .`, `ls -R`, broad recursive grep, full lockfile dumps, generated fixture dumps, and unwrapped test commands.

If the MCP server is unavailable but the `frontload` CLI works, use these fallbacks: `frontload dossier "<task>"`, `frontload search "<query>"`, `frontload read <path> --budget <chars>`, `frontload run --kind <kind> -- <command>`, `frontload diff`, and `frontload budget`. Ask the user to run `frontload doctor` and restart Claude Code so MCP configuration is reloaded. If `frontload --version` is not available in their shell, ask them to run `npx frontload init` again or install the package globally. For a local source checkout, build Frontload with `pnpm build` and reload plugins.
