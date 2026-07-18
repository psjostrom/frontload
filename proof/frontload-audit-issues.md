# Frontload Codex Audit Issue Log

Date opened: 2026-07-12

Scope: Frontload 0.3.1 at `318b17f832b7b0d6e152a073b3e4b36715a6654f`, Codex CLI 0.144.1, macOS arm64.

This log records Frontload problems encountered while designing and running the
Codex net-benefit audit. Generated evidence paths are relative to the audit
worktree and live under ignored `.frontload/audit/` unless stated otherwise.
Suspected causes are explicitly labeled as hypotheses.

## FL-AUD-001 — Budget summary is not a complete net-token calculation

- Severity: High, measurement integrity
- Context: `fl_budget_report` and `frontload budget`
- Expected: A reported net saving should include all Frontload model-visible
  overhead that is needed to complete the work.
- Observed: The report subtracts measured output bytes from selected modeled
  baselines, while dossier, index, policy, setup, failed attempts, retries,
  fallback calls, skill/tool-definition overhead, and other unmeasured operations
  do not reduce `netSavedBytes`. The existing proof also models controls from
  changed-file size rather than observed Codex sessions.
- Reproduction: Read `src/budget/events.ts`; compare `byOperation.dossier` and
  `unmeasuredOperations` with `netSavedBytes`. Then inspect
  `proof/strimma-springa-token-cost-report.md`.
- Frequency: Deterministic by design.
- Impact: Can report a large positive saving without establishing that an actual
  Codex task used fewer total tokens or remained correct.
- Workaround: Use Codex usage telemetry from paired completed tasks and treat the
  Frontload budget as a diagnostic only.
- Evidence: Audit design section “Why Existing Evidence Is Insufficient”; initial
  worktree budget reported 114 unmeasured operations while excluding them from
  net saving.
- Likely component: `src/budget/events.ts` and proof methodology.

## FL-AUD-002 — Hook rewrite can execute a command in the wrong repository

- Severity: Critical, correctness and data integrity
- Context: An initialized Frontload worktree containing nested independent git
  repositories used as benchmark templates.
- Expected: A command launched with a nested repository as its working directory
  must execute that repository's script, or the hook must leave it unchanged.
- Observed: Three `npm test` calls launched with three different nested p-map
  working directories were rewritten by the global Frontload Bash hook. All three
  summaries ran the parent Frontload worktree's Vitest suite and returned parent
  Frontload test names instead of p-map AVA tests. Two other nested benchmark
  repositories were also mutated with ignored `.frontload/events.jsonl` and log
  files during corpus validation, which would have contaminated control trials.
- Reproduction:
  1. Initialize a parent repository with Frontload and global Codex hooks.
  2. Create an independent git repository below it with a different `npm test`.
  3. Issue a Codex Bash call with the nested repository as the tool working
     directory.
  4. Observe the rewritten command's summary and `fullLogPath`.
- Frequency: 3 of 3 concurrent validation calls.
- Impact: False passing verification, edits/tests against the wrong project, and
  potentially unsafe commands in an unintended repository. The audit initially
  received three false gold-pass results and rejected them after inspecting the
  listed test names. It also had to remove Frontload state from two frozen
  templates and add a fail-closed template isolation assertion before trials.
- Workaround: Run validation through a child process that bypasses the outer hook,
  and assert repository identity before every primary command.
- Evidence: Parent log
  `.frontload/logs/2026-07-12T07-37-12-366Z-test.log`; rejected validation output
  listed `tests/unit/indexer.test.ts` and other Frontload tests for all three p-map
  repositories. The removed template artifacts were timestamped
  `2026-07-12T07:34:35Z`; their event records identified `source: "cli"` and
  `operation: "run"`.
- Likely component: Hypothesis — hook context uses the thread/project directory
  rather than the Bash tool's requested working directory before constructing the
  `--repo-from-cwd` rewrite.

## FL-AUD-003 — Concurrent run summaries can select the same log path

- Severity: High, evidence integrity
- Context: Three Frontload-rewritten test commands started concurrently.
- Expected: Every summarized command gets a unique immutable full-log path.
- Observed: All three results reported exactly
  `.frontload/logs/2026-07-12T07-37-12-366Z-test.log`.
- Reproduction: Start multiple `frontload run --kind test` operations within the
  same millisecond and compare `fullLogPath`.
- Frequency: 3 of 3 concurrent calls in the observed batch.
- Impact: Logs can overwrite or interleave, making findings and later debugging
  non-reproducible.
- Workaround: Serialize calls in the audit and hash each captured evidence file.
- Evidence: Same evidence as FL-AUD-002.
- Likely component: Hypothesis — `nowStamp()` provides millisecond timestamps but
  no collision-resistant suffix or exclusive-create loop.

## FL-AUD-004 — Default Codex MCP approval mode fails unattended operation

- Severity: High, normal-flow reliability and token cost
- Context: An isolated repository initialized with
  `frontload init --agents codex --force`, then used from non-interactive
  `codex exec`. Post-run audit found an equal ignored `.frontload` artifact in
  both qualification templates, so the exact token delta is provisional pending
  a clean repeat; MCP approval behavior itself is directly observed.
- Expected: After initialization and explicit hook trust, the documented normal
  Frontload workflow should be usable without repeated manual intervention.
- Observed: Frontload generated
  `default_tools_approval_mode = "prompt"`. Two dossier calls were cancelled as
  `user cancelled MCP tool call`; Codex retried, then fell back to a raw command.
  Treatment used 77,428 total tokens and 31.6 seconds versus 23,882 tokens and
  9.4 seconds for the equivalent isolated control qualification.
- Reproduction:
  1. Initialize a clean repo for Codex.
  2. Run `codex exec --json` with a prompt that uses `fl_repo_dossier`.
  3. Do not attach an interactive approval responder.
  4. Inspect MCP item status and fallback commands.
- Frequency: 2 of 2 MCP calls in the literal-default qualification.
- Impact: 53,546 incremental tokens in the trivial paired qualification, two
  failed MCP calls, one raw fallback command, and no Frontload result. Interactive use also requires
  approval under the generated mode.
- Workaround: After explicit developer trust, set the server mode to `approve`.
  The 36 primary trials use this as an optimistic steady-state ceiling and retain
  the default-path failure in the reliability verdict.
- Evidence:
  `.frontload/audit/runs/qualification-attempt-2-treatment/events.jsonl` and
  `.frontload/audit/qualification/attempt-2.json`.
- Likely component: `codexMcpTomlBlock()` in `src/install/install.ts` writes
  `prompt`. Current Codex source defines `approve` as the only mode that never
  requests tool approval; `auto` still prompts for tools without safe annotations.

## FL-AUD-005 — Dirty-tree packaging silently includes untracked allowlisted files

- Severity: Medium, dogfood and release confidence
- Context: `npm pack` from the audit worktree after creating untracked files under
  `docs/`.
- Expected: The dogfood artifact should represent the current committed
  `origin/main` package contents.
- Observed: The first tarball silently included the untracked 12.5 KB audit spec
  and 18.3 KB audit plan because `docs/` is allowlisted in `package.json`. It grew
  from the clean artifact's 70.6 KB/89 files to 81.7 KB/91 files.
- Reproduction: Add any untracked file under `docs/`, run `npm pack`, and inspect
  the tarball listing.
- Frequency: 1 of 1 dirty pack attempt.
- Impact: Dogfood can test a package different from the intended commit; setup
  byte/time measurements can be inflated.
- Workaround: Pack from a clean `git archive` source tree and hash the selected
  artifact.
- Evidence: `.frontload/audit/setup/package-build.json`.
- Likely component: Dogfood workflow lacks a clean-package-source guard. npm's
  inclusion behavior itself is expected.

## FL-AUD-006 — Empty dogfood cleanup glob errors under default zsh settings

- Severity: Low, setup friction
- Context: The repository dogfood command
  `rm -f .frontload/dogfood/frontload-*.tgz` when no tarball exists.
- Expected: Cleanup succeeds whether or not an old tarball exists.
- Observed: zsh emitted `no matches found` before `rm` ran.
- Reproduction: Run the documented cleanup in a default zsh with an empty target
  directory.
- Frequency: 1 of 1 empty-directory attempt.
- Impact: A strict script or chained workflow can stop before build/pack.
- Workaround: Use a shell-portable cleanup mechanism that tolerates zero matches.
- Evidence: Initial packaging transcript; the audit used a clean destination
  afterward.
- Likely component: Repository dogfood instructions rather than runtime Frontload.

## FL-AUD-007 — Budget report creates substantial recurring model-visible overhead

- Severity: High, token cost
- Context: The initialized Frontload skill instructs agents to request budget
  reports during larger tasks; the CLI and MCP report include detailed `largest`
  and `last20` event arrays.
- Expected: Cost accounting used during normal work should be compact enough that
  observing savings does not materially erase them.
- Observed: After four measured workflow operations, `frontload budget` emitted
  4,826 bytes. After the same four operations were repeated warm, it emitted
  7,880 bytes. The second report repeats operation records in both `largest` and
  `last20`; at the product's own chars-per-four estimate, those two reports alone
  expose roughly 3,177 tokens before counting their requests or agent responses.
- Reproduction: In a clean initialized fixture, run dossier, search, budgeted
  read, and summarized test once; call `frontload budget`; repeat the workflow
  and call it again. Compare stdout byte sizes.
- Frequency: 2 of 2 measured reports; deterministic growth with retained events
  until list caps are reached.
- Impact: Recurring introspection overhead can dominate savings on narrow tasks,
  especially when the skill asks for reports before and after repair loops.
- Workaround: Do not use report byte estimates as proof of net savings; in normal
  work, avoid repeated full reports unless diagnosing a failure.
- Evidence: `.frontload/audit/setup/cold.json` and `warm.json`; corresponding
  `benchmark/*-output/*budget-report.stdout.log` files.
- Likely component: Hypothesis — budget serialization returns redundant detailed
  history by default instead of a concise summary with opt-in detail.

## FL-AUD-008 — Live MCP server remains silently bound to the wrong worktree

- Severity: Critical, correctness and token cost
- Context: The task began in the main checkout, then created and initialized an
  isolated audit worktree and continued in that worktree without restarting the
  Codex task.
- Expected: Repository tools should operate on the active repository, reload the
  new project configuration, or reject a repository identity mismatch.
- Observed: `fl_repo_dossier`, `fl_policy`, and `fl_search` all succeeded but the
  MCP server wrote their events to `<original-checkout>/.frontload/` rather than
  the active audit worktree. It therefore searched the original
  checkout while presenting results as current-repository context.
- Reproduction:
  1. Start Codex in an initialized checkout and use a Frontload MCP tool.
  2. Create another worktree, run `frontload init` there, and change shell workdir.
  3. Without restarting the task, call the same MCP tools.
  4. Compare event timestamps in both repositories' `.frontload/events.jsonl`.
- Frequency: 3 of 3 live MCP calls after the worktree transition.
- Impact: Plausible but wrong repository context can drive incorrect edits and
  tests. The three observed responses exposed 16,096 output bytes, roughly 4,025
  tokens at Frontload's estimate, before the mismatch was proven and CLI
  fallbacks resumed.
- Workaround: Restart Codex after initialization and assert repository identity
  before trusting the first tool response. Every primary audit trial starts a
  fresh isolated Codex process and checks its MCP listing.
- Evidence: Original-checkout events at `2026-07-12T08:09:57.517Z`,
  `08:10:08.772Z`, and `08:10:14.491Z`; no corresponding MCP events in the audit
  worktree.
- Likely component: Hypothesis — the generated MCP command captures an absolute
  `--repo` at server launch and exposes no active-worktree identity guard.

## FL-AUD-009 — Default command policy rejects a normal targeted test workflow

- Severity: High, normal-flow friction and token cost
- Context: First valid primary treatment, fixing p-map iterable index ordering.
- Expected: Frontload should let Codex run the repository's normal narrow test,
  or steer it to an equivalent permitted command without a failed tool turn.
- Observed: Codex called `fl_run_summary` with a focused
  `npx ava test.js --match=...` command. Frontload rejected it as not allowed.
  Codex then called `fl_policy`, ran the broader `npm test`, and later used raw
  `git diff` despite already calling `fl_git_diff_summary`. In the abort-signal
  task, Frontload likewise rejected the repository-local
  `./node_modules/.bin/xo` lint command. In the iterable-API task it rejected
  three more standard repository commands: `npx ava test.js`, `npx tsd`, and
  `npx xo`.
- Reproduction: Initialize the frozen p-map fixture and call `fl_run_summary`
  with `npx ava test.js --match='<test name>'` under the generated default config.
- Frequency: 7 policy rejections across 5 of 8 valid primary treatment runs.
- Impact: At least one failed MCP turn plus policy lookup and a broader test run.
  The complete treatment remained correct but used 517,091 tokens and 224.3s,
  versus 168,722 tokens and 110.9s for its correct paired control; the exact
  fraction attributable to the denial cannot be isolated from this trace.
- Workaround: Use the broader allowed `npm test`, manually expand policy, or fall
  back to a raw targeted command.
- Evidence: `.frontload/audit/runs/pmap-index-order-r1-treatment/events.jsonl`,
  failed MCP item `item_16`; and
  `.frontload/audit/runs/pmap-abort-signal-r1-treatment/events.jsonl`, failed MCP
  item `item_22`; and
  `.frontload/audit/runs/pmap-iterable-api-r1-treatment/events.jsonl`, failed MCP
  items `item_20` through `item_22`.
- Likely component: Default `allowedCommands` policy and skill guidance do not
  cover common repository-specific targeted test commands.

## FL-AUD-010 — Repository dossier timed out after 120 seconds

- Severity: High, latency and token cost
- Context: Read-only Vitest architecture task in a fresh, isolated, pre-approved
  primary treatment session.
- Expected: The initial repository dossier should return bounded orientation or
  fail fast enough for a same-call fallback.
- Observed: `fl_repo_dossier` timed out after 120 seconds. Codex then continued
  with raw repository commands. The treatment still reached the same 3/4 manual
  rubric score as control but used 1,687,581 tokens and 488.4s, versus 701,001
  tokens and 259.8s for control.
- Reproduction: Run the frozen `vitest-browser-pretransform-review` treatment
  task with the audit package and inspect the first dossier call.
- Frequency: 1 of 1 measured large read-only treatment runs.
- Impact: The failed call consumed two minutes before fallback. The precise token
  share attributable to the timeout cannot be isolated, but the paired treatment
  used 986,580 more tokens and 228.6s more wall time.
- Workaround: Skip dossiers for broad read-only tasks and use Codex's normal
  bounded search/read tools.
- Evidence:
  `.frontload/audit/runs/vitest-browser-pretransform-review-r1-treatment/events.jsonl`,
  failed MCP item `item_4`.
- Likely component: Hypothesis — dossier indexing or synthesis exceeded the MCP
  client's fixed 120-second call deadline on this repository snapshot.

## FL-AUD-011 — Codex integration increases end-to-end token use

- Severity: Critical, product mission failure
- Context: All 8 complete primary Codex A/B pairs across 6 frozen task classes.
- Expected: Initialization should lower total tokens needed for the same verified
  result, with no correctness loss.
- Observed: Control used 3,660,058 total tokens; Frontload treatment used
  5,854,651, an increase of 2,194,593 or 59.96%. Treatment made 153 Frontload
  tool calls and recorded 8 Frontload failures. The frozen parser counted 38 raw
  command calls after the first Frontload failure in affected traces; this is a
  post-failure-path count, not a claim that every call was a direct retry.
  Cached input increased by 2,131,200 tokens (+66.60%). Even excluding cached
  input, treatment used 63,393 more uncached-input-plus-output tokens (+13.78%).
  Both arms verified 8/8 and scored 31/32 in the manual frozen-rubric review.
- Reproduction: Use the frozen manifest, schedule seed 20260711, and isolated
  arm homes under `.frontload/audit/`; compare the complete pairs recorded in
  `.frontload/audit/analysis/results.json`.
- Frequency: Frontload was worse in 6 of 8 pairs and in 4 of 6 task classes. It
  produced a practical greater-than-10% saving in only 1 of 8 pairs.
- Impact: In the observed corpus, disabling Frontload would have avoided
  2,194,593 tokens and 535,296ms while preserving the same measured quality.
- Workaround: Disable the Frontload MCP/skill integration and use normal Codex
  tools until a replacement architecture passes an end-to-end release gate.
- Evidence: `.frontload/audit/analysis/results.json`, `.frontload/audit/results.jsonl`,
  and `.frontload/audit/analysis/manual-quality-review.json`.
- Likely component: Hypothesis supported by the token split and traces — the
  MCP/skill workflow adds tool turns that repeatedly carry the session context,
  while Codex already bounds many raw reads and command outputs. Payload
  compression does not usually repay the extra turns.

## FL-AUD-012 — Pausing the repository does not stop an already loaded installation

- Severity: High, rollout and normal-flow reliability
- Context: Implementing the paused product revision in a linked worktree while
  the current Codex task still had Frontload 0.3.1 loaded from an earlier init.
- Expected: A paused release should not leave developers believing the active
  integration has stopped when a stale hook or MCP process is still running.
- Observed: Commands in the pause worktree continued to be rewritten and
  summarized by the previously installed Frontload hook. For example, the full
  unit run returned a Frontload command-summary envelope and wrote a Frontload
  log even though the source revision under test had disabled agent entrypoints.
  The already loaded MCP process also remained attached to the original checkout,
  as recorded in FL-AUD-008. Source changes alone cannot alter either process.
- Reproduction: Initialize Frontload 0.3.1 in Codex, keep the task open, switch
  to the paused revision without installing it, and run a normally rewriteable
  command such as `pnpm test`.
- Frequency: Deterministic for the current task until the installed package and
  loaded agent configuration are replaced or removed.
- Impact: The developer can keep paying the token and reliability cost of the
  product after seeing the repository marked paused. It also obscures verification
  output while working on the pause itself.
- Workaround: Install the paused revision or remove the existing Frontload agent
  configuration, then restart the agent so stale hooks and MCP processes exit.
- Evidence: The pause-worktree unit run at
  `.frontload/logs/2026-07-18T09-49-10-456Z-test.log`; current-task MCP behavior
  recorded in FL-AUD-008.
- Likely component: Release and uninstall lifecycle. Frontload has no way for a
  repository revision to revoke already loaded global configuration or processes.

## Non-Frontload constraints intentionally excluded

- The OpenAI Codex manual helper rejected a response missing its integrity header.
- Codex CLI 0.139.0 rejected `gpt-5.6-sol`; the audit installed 0.144.1 locally.
- The account reached its Codex usage limit before approval-mode qualification
  attempt 3 and reported a reset at 14:25 local time.
- Later quota-only attempts were rejected before model output with resets at
  19:26 on July 12 and 09:10 on July 18. They are archived as invalid external
  attempts and never charged to either arm.
- After the second quota reset, the developer capped the audit at 16 valid
  sessions so the full effort would fit within two weekly allowances and leave
  capacity for report questions. One in-progress control was cancelled without a
  final usage event, archived as invalid, and excluded. This reduces statistical
  precision but does not remove any completed pair or task class.
- Historical p-map lint dependencies became incompatible without a lockfile; the
  corpus now freezes generated locks and validates AVA/TSD directly.
- The audit runner initially rewrote relative `node_modules/.bin` symlinks while
  cloning the first control. The 349,093-token attempt is retained under
  `.frontload/audit/invalid-runs/` but excluded from both experimental arms; the
  runner now preserves symlinks verbatim and has a regression test.
- The frozen tooltip baseline had unrelated NodeNext typecheck errors, making its
  initial typecheck verifier impossible for either arm. The 337,149-token first
  treatment is retained as invalid evidence; only the non-discriminating
  typecheck verifier was removed, and both arms are rerun.
