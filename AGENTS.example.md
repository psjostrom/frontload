# Frontload workflow

Before broad exploration, call `fl_repo_dossier`.

Prefer:
- `fl_search` over broad grep
- `fl_read_budgeted` over raw full-file reads
- `fl_run_summary` over raw test/typecheck commands
- `fl_git_diff_summary` over raw full diff dumps
- `fl_budget_report` before and after large tasks

Do not read unrelated files unless the dossier suggests them or you explain why.

Do not run more than two repair loops on the same failure without checking `fl_budget_report` and creating a new focused dossier.

When tests fail, pass only the summarized failure back into reasoning unless the full log is truly needed.

For this repository, verify changes in the same order CI uses:
- `pnpm lint`
- `pnpm build`
- `pnpm test`
- `pnpm e2e`
- `node dist/src/cli/index.js validate-plugins --repo .`
