# Frontload workflow

Use the Frontload MCP tools before broad repo exploration. Start with `fl_repo_dossier`, then targeted `fl_read_budgeted` calls, and run tests through `fl_run_summary`.

Prefer:
- `fl_search` over broad grep
- `fl_read_budgeted` over raw full-file reads
- `fl_run_summary` over raw test/typecheck commands
- `fl_git_diff_summary` over raw full diff dumps
- `fl_budget_report` before and after large tasks

For this repository, verify changes in the same order CI uses:
- `pnpm lint`
- `pnpm build`
- `pnpm test`
- `pnpm e2e`
- `node dist/src/cli/index.js validate-plugins --repo .`
