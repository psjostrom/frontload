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

`fl_read_budgeted` returns a contiguous `excerpt` that can be used for edits when `editSafe` is true. Use `numberedExcerpt` for display and line references. Follow `nextRead` or `previousRead` to page through large files. Character budgets stop at complete-line boundaries; a single oversized line is returned intact rather than skipped or partially returned.

## Savings measurement

`fl_budget_report` separates exact measured operations from unmeasured
operations. Exact byte baselines are available for:

| Tool or hook | Baseline |
| --- | --- |
| `fl_run_summary` | captured raw command output |
| `fl_read_budgeted` | complete file bytes |
| `fl_git_diff_summary` | complete raw patch |
| `fl_search` | the same unbounded Frontload result set |
| enabled `fl_local_scout` | uncapped local command output |
| PostToolUse hook compaction | observed native tool output |

Indexing, dossiers, policy output, and cost comparison remain unmeasured. Search
does not claim native grep savings. `netSavedBytes` is signed, so a metadata-rich
response that exceeds a small baseline appears as negative savings rather than
being clamped to zero. Token savings remain directional estimates derived from
bytes divided by four.
