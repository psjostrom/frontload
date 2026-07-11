# Frontload Agent Instructions

Frontload exists to make initialized AI coding harnesses behave, from the developer's perspective, just like they did before: same ability, same workflow, fewer tokens, and ideally faster responses. After `frontload init`, developers should not need to think about Frontload in normal use. If an agent needs less context, it should get that efficiency without becoming less capable.

Treat any normal-flow friction as a product problem: stale MCP processes, noisy setup, extra manual steps, surprising command failures, excessive CPU/RAM, or behavior that makes the developer babysit Frontload.

## Agent Priorities

- Preserve harness behavior first. Frontload should be an invisible context and cost gateway, not a new workflow users must manage.
- Reduce token use without reducing agent judgment. Use dossiers, search, budgeted reads, summarized command output, and diff summaries, but fetch more context when correctness requires it.
- Prefer real integration behavior over mocked internals. The value is that agents can work normally in real repositories with less context.
- Keep user-visible setup, config, plugin, hook, MCP, and install-flow changes documented.
- Keep changes narrow. Do not make drive-by refactors, formatting churn, or unrelated lint fixes.

## Core Commands

```bash
pnpm install
pnpm lint
pnpm build
pnpm test
pnpm e2e
node dist/src/cli/index.js validate-plugins --repo .
pnpm proof
```

`pnpm-workspace.yaml` is intentional even though this is not a workspace. It disables pnpm's pre-run auto-install check and explicitly approves `esbuild` postinstall scripts so Codex runtime pnpm can run scripts deterministically.

CI runs, in order: `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm e2e`, then `node dist/src/cli/index.js validate-plugins --repo .`.

## Frontload Workflow

This repo dogfoods Frontload through the normal user install and init path. Always dogfood Frontload code from the latest `origin/main` commit or newer: fetch `origin/main`, confirm the current branch is equal to or descended from it, then build, pack, install, and initialize the package like a user would.

```bash
pnpm build
mkdir -p .frontload/dogfood
rm -f .frontload/dogfood/frontload-*.tgz
npm pack --pack-destination .frontload/dogfood
npm install -g .frontload/dogfood/frontload-*.tgz
frontload init --repo . --agents codex --force
frontload doctor --repo . --dogfood
```

Restart Codex after `frontload init` so MCP configuration is reloaded. Do not dogfood an older global `frontload` install in this repo.

Before broad exploration, call `fl_repo_dossier` when the Frontload MCP tools are available. Treat Frontload tool failures, timeouts, stale MCP processes, or excessive CPU/RAM during Frontload development as product bugs to investigate, not as ordinary workflow noise.

Prefer:

- `fl_search` over broad grep
- `fl_read_budgeted` over raw full-file reads
- `fl_run_summary` over raw test/typecheck commands
- `fl_git_diff_summary` over raw full diff dumps
- `fl_budget_report` before and after large tasks

Do not read unrelated files unless the dossier suggests them or you explain why. Do not run more than two repair loops on the same failure without checking `fl_budget_report` and narrowing the task context.

When tests fail, pass only the summarized failure back into reasoning unless the full log is truly needed.

## Project Map

- `src/cli/` - CLI entrypoint and option parsing
- `src/commands/` - user-facing command implementations
- `src/config/` - config loading, defaults, and validation
- `src/indexer/` - repository indexing
- `src/dossier/`, `src/diff/`, `src/budget/` - context planning and savings reports
- `src/gate/` and `hooks/` - hook entrypoints and host command gating
- `src/mcp/` - MCP server and tool wiring
- `plugins/codex/`, `plugins/claude/`, `plugins/opencode/` - bundled plugin adapters
- `skills/frontload/` - shared Frontload skill source
- `tests/unit/`, `tests/e2e/` - Vitest test suites
- `fixtures/react-ts-app/` - fixture repo used by e2e and proof commands
- `proof/` - stable, hand-authored proof reports; generated proof artifacts stay under ignored `.frontload/proof/`

## Testing

Use integration-style tests around real CLI behavior where practical. Keep unit tests focused on pure logic, parsing, config, and edge cases.

- Add or update tests for behavior changes.
- Run the relevant narrow test first, then the CI sequence before declaring work complete.
- For changes to plugin packaging, hooks, skills, or manifests, run `pnpm build` before `node dist/src/cli/index.js validate-plugins --repo .`.
- For changes to the proof/demo path, run `pnpm proof`.

## Documentation

Any user-visible CLI, config, plugin, hook, MCP, or install-flow change is not done until docs are checked.

Before completion:

1. Search `README.md`, `docs/`, `AGENTS.md`, `plugins/*/README.md`, `skills/frontload/SKILL.md`, and `plugins/*/skills/frontload/SKILL.md` for references to the changed behavior.
2. Update stale command examples, setup steps, and workflow descriptions.
3. If no docs describe a new user-visible feature, add the smallest useful documentation in the existing style.

## Git Workflow

`main` must have a clean, conventional history like Strimma and Springa.

- At the start of work on `main`, run `git pull --ff-only origin main` before inspecting files or making claims about current workflow, release, or branch state. If fast-forward is impossible, stop and report the blocker instead of working from stale local state.
- Use PRs into `main`; do not push feature work directly to `main`.
- Branch names should describe the work, not the tool. Do not use `codex/...`, agent names, or other tool prefixes unless explicitly requested.
- The PR title is the future `main` commit title. Write it as a conventional commit: `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `refactor: ...`, `ci: ...`, or `chore(...): ...`.
- Never prefix PR titles or commit titles with `[codex]`, `codex:`, agent names, branch names, or tool names.
- Use squash merge for PRs. Do not use merge commits. Do not use rebase merge for feature PRs.
- Before merging, confirm the final squash title is conventional and has no agent prefix.
- Release PR titles should also be conventional, for example `chore(release): bump version to 0.1.10`; do not use bare `Release 0.1.10`.
- When a merge or push fails, inspect the exact error first. If a PR exists and the failure is due to pending or failed checks, run `gh pr checks <pr-or-branch>` and read the failure logs before retrying. Never blindly force-push or retry.

## Release Notes

Before a release, identify the previous release ref before writing notes. Prefer the latest `vX.Y.Z` tag once release tags exist. Until then, find the previous release commit on `main` with `git log main --oneline --grep='Release' --grep='chore(release)'` and use that commit SHA. Then run:

```bash
git log <previous-release-ref>..main --oneline
```

If no previous release ref exists, run `git log main --oneline` and summarize all commits. Do not assume the latest commit is the whole release.

The package version lives in `package.json`; `src/version.ts` reads that value at runtime. Keep the lockfile consistent when package metadata changes.

Npm publishing runs from `.github/workflows/npm-publish.yml` after release version bumps reach `main`. The workflow uses npm trusted publishing with GitHub Actions OIDC; do not add long-lived `NPM_TOKEN` or `NODE_AUTH_TOKEN` publish secrets. Create release bump PRs with `.github/workflows/create-release-pr.yml` or `pnpm release:pr --bump patch`; review and merge the PR to trigger publishing.

## Security

Frontload is local-first. Do not add runtime LLM API calls, source upload, or external telemetry. Command logs stay under `.frontload/logs/`, and budgeted reads must continue to redact common secret patterns.
