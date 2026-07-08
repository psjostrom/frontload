---
name: frontload
description: Use this when working in a code repository with the Frontload MCP server to reduce context, summarize tests, produce task dossiers, and avoid expensive broad exploration.
---

# Frontload

Start with `fl_repo_dossier` for the current task. Use `fl_search` for indexed search and `fl_read_budgeted` for bounded file excerpts.

Run tests, typechecks, and lint through `fl_run_summary` so raw logs stay local while failures are summarized. Use `fl_git_diff_summary` before reviewing changes and `fl_budget_report` before repeating repair loops.

If the MCP tools are unavailable but the `frontload` CLI works, use these fallbacks:

- `fl_repo_dossier` -> `frontload dossier "<task>"`
- `fl_search` -> `frontload search "<query>"`
- `fl_read_budgeted` -> `frontload read <path> --budget <chars>`
- `fl_run_summary` -> `frontload run --kind <kind> -- <command>`
- `fl_git_diff_summary` -> `frontload diff`
- `fl_budget_report` -> `frontload budget`

Avoid raw `find .`, `ls -R`, broad `grep -R`, full lockfile dumps, and unwrapped test commands.
