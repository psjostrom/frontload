# Codex Net-Benefit Audit Design

Date: 2026-07-11

## Purpose

Determine whether initializing Frontload produces a positive net token benefit
for a developer using Codex on macOS. The audit must count setup and integration
overhead, normal Frontload output, retries, failures, fallbacks, and verification
work. Token savings do not count as a benefit when task correctness or agent
judgment is worse.

The primary scope is Codex CLI and Codex-compatible project integration in this
environment. Results must not be generalized to Claude or opencode. An opencode
smoke check is permitted only to isolate a suspected Frontload defect and must be
reported separately.

## Why Existing Evidence Is Insufficient

`proof/strimma-springa-token-cost-report.md` is useful exploratory evidence, but
it cannot establish net benefit because:

- its main control estimates that an agent loads every changed file;
- its patch-only comparison is not an observed agent run;
- failed verification commands remain in the modeled Frontload path;
- setup is reported separately rather than amortized;
- the budget reporter excludes unmeasured operations from net savings;
- it does not measure task correctness, retries, fallbacks, or actual Codex usage;
- it has no repeated trials to estimate Codex run-to-run variation.

This audit therefore treats Frontload's budget report as diagnostic evidence,
not as the primary outcome.

## Hypotheses

The primary null hypothesis is that Frontload does not lower the total Codex
tokens needed to obtain a verified successful outcome.

The benefit hypothesis is that Frontload lowers paired median total Codex tokens
by at least 10%, with an uncertainty interval below zero, without lowering
verified completion or introducing a severe normal-flow reliability regression.

Secondary hypotheses are that benefits depend on task class, with possible
regressions on narrow tasks and larger savings on multi-file or noisy-output
tasks.

## Experimental Arms

Each task starts from two byte-identical repository snapshots with fresh state.

### Control

- Frontload project state, MCP configuration, hooks, and skills are absent.
- Codex uses its standard repository tools and commands.
- The task prompt does not mention Frontload.
- The recorded tool trace must confirm that no Frontload tool was available or
  invoked. If global Codex configuration leaks Frontload into the control arm,
  the run is invalid and the isolation method must be fixed before continuing.

### Treatment

- Frontload is built and packed from the current `origin/main` commit or newer.
- The packed package is installed and initialized through the normal user path.
- A fresh Codex process is used after initialization so project configuration is
  actually loaded.
- The task prompt is identical to the control prompt and does not instruct Codex
  to use specific Frontload tools.
- The trace records whether the installed integration caused Codex to use the
  intended workflow without developer babysitting.

Qualification amendment frozen on 2026-07-12, before primary trials: Frontload
0.3.1 generates `default_tools_approval_mode = "prompt"`, which caused both MCP
calls in non-interactive Codex to be cancelled and followed by raw fallbacks.
Preserve that literal-default run as setup and reliability evidence. For the 36
primary sessions, change only this generated setting to `"approve"` after init,
simulating a developer who has explicitly trusted Frontload. Primary treatment
results are therefore an optimistic steady-state ceiling, not out-of-box behavior.

Harness amendment frozen on 2026-07-12 before the first treatment trial: the
first scheduled control clone revealed that Node's default recursive copy rewrote
relative `node_modules/.bin` symlinks into absolute links to the corpus template.
That environment could not run AVA and was not a valid corpus clone. Preserve the
349,093-token attempt under `invalid-runs`, exclude it from both arms, require
verbatim symlink copies, revalidate the agent patch against hidden tests, and
restart the schedule at the same control run ID. This arm-independent correction
was made before observing any primary treatment result.

Verifier amendment frozen on 2026-07-12 before the tooltip control trial: the
first tooltip treatment exposed unrelated NodeNext import-extension failures in
the frozen baseline's `npm run typecheck`. Because that verifier was impossible
for either arm and did not test the target behavior, archive the 337,149-token
treatment attempt as invalid, remove only that typecheck command, retain the
failing-then-passing visible tooltip test as the verifier, and rerun both arms.
No tooltip control result was observed before this arm-independent correction.

Treatment setup failures belong to the treatment arm. A repaired setup may be
used for later trials, but setup repair cost and the original failure remain in
the setup and reliability results.

## Repository and Task Corpus

Use six tasks across at least two repository snapshots. Prefer real historical
tasks with a known later fix. A synthetic task is allowed only when it exercises
a behavior not represented by a suitable historical task, and the injected bug
and expected behavior must be recorded before the first run.

The fixed task-class allocation is:

1. narrow investigation or fix;
2. narrow investigation or fix;
3. medium multi-file change;
4. medium multi-file change;
5. noisy failing-command diagnosis;
6. read-only review or architecture question.

For a historical task, export the parent of the gold commit into a new repository
that does not contain the gold commit or its objects. The task manifest stores the
source repository, base commit, gold commit, prompt, time limit, verification
commands, semantic rubric, and disallowed shortcuts. Gold patches and answer keys
must remain outside the agent-visible worktree.

Exact task manifests must be frozen before launching the first paired trial. No
task may be removed because Frontload performs poorly. A task may be declared
invalid only for an arm-independent reason such as an unreproducible gold test;
the reason and all partial results must remain in the report.

## Repetitions and Ordering

The original design called for three fresh repetitions per arm per task: 6 tasks
x 2 arms x 3 repetitions, for 36 Codex sessions.

- Use the same Codex CLI version, model, reasoning level, permissions, and timeout
  for every run.
- Run sessions sequentially to avoid CPU, memory, and filesystem contention.
- Randomize arm order within each task/repetition pair using a recorded seed.
- Interleave task pairs rather than completing all treatment or control runs
  first.
- Do not resume sessions. Every run starts without conversation history.
- Preserve every attempt, including timeouts and malformed outputs.

The fixed repetition count prevents optional stopping after favorable results.

### Quota-cap amendment (2026-07-18)

The original 36-session design exhausted a full weekly Codex allowance before it
was complete. The developer then explicitly capped the entire measurement effort
at two weekly allowances and required enough remaining allowance for questions
about the final report. Primary model runs therefore stopped after 16 valid
sessions forming 8 complete pairs. The completed sample covers all six frozen task
classes; the two narrow tasks have a second repetition. A seventeenth session was
cancelled during the redesign, archived as invalid, and excluded because it has
no final usage event.

This is a resource stop, not an outcome-based stop: no task was removed, all
completed control/treatment pairs are reported, and the stop was requested after
the quota cost itself became material. No more Codex trial or scorer sessions are
permitted for this audit. The original 36-session target remains documented so
the reduced precision is visible. The final report must:

- treat inference beyond this fixed six-task corpus as limited;
- report the descriptive task-stratified bootstrap but not present it as a
  population-level confidence guarantee, because four tasks have one repetition;
- use deterministic hidden verification plus a manual rubric review instead of
  spending another model session on blind scoring;
- state that the manual review is not independent or blind;
- distinguish Codex JSONL token telemetry from the unpublished subscription-quota
  accounting used by the product.

## Measurements

Before the task trials, run one minimal instrumentation qualification session in
an isolated scratch repository. Confirm the Codex JSONL event names, whether usage
values are cumulative, how tool calls are represented, and whether the selected
configuration actually isolates the two arms. This session is audit overhead,
not evidence for either arm. Freeze the parser and environment checks after this
qualification and before the first task result is observed.

### Primary token outcome

Use Codex's own machine-readable usage telemetry. Establish whether usage events
are per-turn or cumulative before aggregating them. Store:

- input tokens;
- cached input tokens when available;
- uncached input tokens when derivable;
- output tokens;
- total tokens;
- tokens consumed by retries or fallback attempts.

The primary comparison is total tokens required to obtain the verified outcome
under an intention-to-treat rule. Cached and uncached input are reported
separately. Frontload's `chars / 4` estimates are secondary diagnostics only.

### Correctness and fidelity

Code tasks must pass the same arm-independent hidden verification. A semantic
rubric derived from the gold behavior detects incomplete or accidental passes.
Patch similarity is not itself a requirement.

Read-only tasks use an answer-key checklist written before either arm is run.
Outputs are relabeled with randomized opaque identifiers before rubric scoring.
The scorer must not receive tool traces, token usage, or arm labels.

Record verified success, rubric score, regressions introduced, and whether the
agent made unsupported factual claims.

### Reliability

Record every Frontload-specific:

- unavailable, timed-out, malformed, or non-zero tool call;
- stale MCP or wrong-package observation;
- unexpected hook rewrite or blocked normal command;
- fallback to standard repository tools;
- manual intervention or restart;
- repeated or irrelevant read/search caused by poor ranking;
- response that exceeds its documented or configured useful bound.

A fallback is not free: its full Codex and elapsed-time cost remains in the
treatment result.

### Latency and resources

Record setup duration, indexing duration, session wall time, tool duration, and
time lost to repair. Capture peak RSS or the closest reliable process metric for
Frontload services when practical. Latency and resources are secondary outcomes
and do not replace token evidence.

## Setup and Amortization

Measure the documented cold user path separately:

1. build and pack the current source;
2. install the packed package;
3. initialize a clean repository for Codex;
4. run doctor;
5. start a fresh Codex process;
6. execute the first dossier/search/read/run workflow;
7. repeat on a warm index.

Record shell output bytes and time even when they are not model tokens. Any Codex
session used to diagnose or repair setup contributes its actual tokens to setup
cost.

Compute break-even task count as one-time treatment token overhead divided by
the observed median per-task token saving. If per-task saving is zero or negative,
break-even is undefined and Frontload does not amortize in the observed corpus.

Project integration or skill content that appears in every Codex session is
recurring overhead, not one-time setup.

Report two setup views: the literal initialized default, including incremental
tokens from cancelled MCP calls and fallback, and the optimistic pre-approved
steady state used by the primary trials. The normal-flow reliability verdict
continues to count the literal-default failure.

## Failure Injection

After normal trials, execute one controlled failure-path exercise without
contaminating primary results. Make a Frontload MCP tool unavailable or force a
safe deterministic failure, then issue a representative repository task.

Measure detection quality, retry count, fallback behavior, extra tokens, and
elapsed time. Do not damage user data, global credentials, or the normal checkout.
Restore the isolated environment after the exercise.

Under the 2026-07-18 quota cap, the planned synthetic failure-injection Codex
session is cancelled. The primary treatment runs already contain eight observed
Frontload failures, 38 classified fallback calls, the literal-default approval
failure, and two critical wrong-repository/stale-server defects. Those natural
failures provide stronger normal-flow evidence without consuming another model
session. The omission is reported as a design limitation.

## Analysis

For each task and overall, report all runs plus:

- paired token difference and percentage;
- median, minimum, maximum, and interquartile range;
- verified completion rate;
- rubric-score difference;
- fallback and Frontload-failure counts;
- setup and warm-operation latency;
- break-even task count.

Use a paired, task-stratified 95% bootstrap interval for the overall token
difference. Because the corpus is small, present task-level data and do not let
one aggregate hide a task class that regresses.

The practical net calculation charges one measured cold setup against the full
six-task corpus, then adds every recurring treatment overhead and all retries.
Report both this six-task net result and the unamortized per-task result. The
break-even calculation shows how conclusions change for developers who perform
more or fewer tasks after initialization.

Verdict categories:

- **Positive:** after charging one cold setup to the six-task corpus, at least 10%
  lower paired median total tokens, uncertainty interval below zero, no worse
  verified completion, and no severe normal-flow reliability regression.
- **Negative:** non-positive net saving after charged retries/setup, worse verified
  completion, or normal operation regularly requires fallback/manual intervention.
- **Inconclusive:** direction varies materially across repetitions or uncertainty
  includes no benefit.

Also report the exact mathematical difference even when it does not cross the
10% practical threshold.

## Stop Conditions

- Terminate a run at its predeclared timeout and count it as failed.
- Stop an affected experiment immediately for destructive or unrecoverable
  behavior and preserve evidence.
- Make at most two repair attempts for the same repeated Frontload failure; check
  the Frontload budget report and narrow context before a second loop.
- If trustworthy Codex usage telemetry cannot be obtained, do not promote
  Frontload's self-reported byte savings to the primary outcome. Limit the verdict
  or declare it inconclusive.
- Do not silently replace an invalid task, missing run, or failed treatment result.

## Evidence and Deliverables

Generated and potentially bulky evidence stays under ignored `.frontload/audit/`:

- task manifests and randomized schedule;
- clean repository snapshots or references needed to reproduce them;
- Codex JSONL streams and final responses;
- command logs, test results, patches, and anonymized scoring inputs;
- Frontload event logs and doctor output;
- machine-readable aggregate tables and analysis output.

Stable repository evidence:

- `proof/codex-net-benefit-audit.md` contains method, environment, full result
  tables, analysis, verdict, limitations, and reproduction commands.
- `proof/frontload-audit-issues.md` contains every Frontload problem encountered,
  including problems found while designing and running the audit.

Each issue entry contains a stable identifier, severity, affected version and
commit, environment, context, expected behavior, observed behavior, reproduction
steps, frequency, token/time impact, workaround or fallback, evidence paths, and
the likely component when supported by evidence. Suspected causes must be labeled
as hypotheses.

## Repository Safety

- Work in ignored audit directories or isolated temporary repositories.
- Do not alter real user data, credentials, or sibling private repositories.
- Do not commit, push, open a PR, or publish findings without explicit user
  instruction.
- Keep source changes out of the audit unless the user separately asks to fix a
  documented issue.
