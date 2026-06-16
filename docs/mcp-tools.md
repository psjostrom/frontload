# MCP Tools

This project uses `@modelcontextprotocol/sdk` with imports from:

- `@modelcontextprotocol/sdk/server/mcp.js`
- `@modelcontextprotocol/sdk/server/stdio.js`

Tools:

- `fl_policy`
- `fl_repo_index`
- `fl_repo_dossier`
- `fl_search`
- `fl_read_budgeted`
- `fl_run_summary`
- `fl_git_diff_summary`
- `fl_budget_report`
- `fl_local_scout`

Each tool returns structured JSON with a human-readable `summary`.

`fl_read_budgeted` returns a contiguous `excerpt` that can be used for edits when `editSafe` is true. Use `numberedExcerpt` for display and line references. Follow `nextRead` or `previousRead` to page through large files.
