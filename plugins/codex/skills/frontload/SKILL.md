---
name: frontload
description: Use when working in a code repository to reduce context cost with Frontload MCP tools, task dossiers, budgeted reads, summarized command output, and token-cost reports.
---

# Frontload

Use Frontload before broad repository exploration.

Default workflow:

1. Start with `fl_repo_dossier` for the current task.
2. Use `fl_search` when the dossier says ranking confidence is noisy or when you need concrete symbols.
3. Use `fl_read_budgeted` for contiguous file windows instead of raw full-file reads. Prefer the raw `excerpt` for edits when `editSafe` is true, and use `numberedExcerpt` only for line references when it is present.
4. Run tests, typechecks, lint, and build commands through `fl_run_summary`.
5. Use `fl_git_diff_summary` before reviewing changes.
6. Use `fl_budget_report` before repeating repair loops.

Avoid raw `find .`, `ls -R`, broad recursive grep, full lockfile dumps, generated fixture dumps, and unwrapped test commands.

If the MCP server is unavailable but the `frontload` CLI works, use these fallbacks: `frontload dossier "<task>"`, `frontload search "<query>"`, `frontload read <path> --budget <chars>`, `frontload run --kind <kind> -- <command>`, `frontload diff`, and `frontload budget`. Ask the user to run `frontload doctor` and restart Codex so MCP configuration is reloaded. If `frontload --version` is not available in their shell, ask them to run `npx frontload init` again or install the package globally. For a local source checkout, build Frontload with `pnpm build` and reload the plugin.
