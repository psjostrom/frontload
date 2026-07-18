# Codex Net-Benefit Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Produce a reproducible, evidence-backed verdict on whether current Frontload lowers total Codex token use without reducing task correctness.

**Architecture:** A local Node.js audit harness prepares immutable public benchmark snapshots, creates isolated control and treatment Codex homes, runs a frozen randomized schedule, captures Codex JSONL and Frontload events, verifies outcomes against hidden gold behavior, and generates stable Markdown reports. Bulky artifacts remain ignored under .frontload/audit/; only the specification, plan, final report, and issue log are stable repository files.

**Tech Stack:** Node.js 20+, audit-local Codex CLI 0.144.1, gpt-5.6-sol with xhigh reasoning, Frontload 0.3.1 built from commit 318b17f, git, npm, pnpm, GitHub CLI, and macOS process tools.

## Global Constraints

- Primary scope is Codex on macOS; do not generalize results to Claude or opencode.
- The original target was 6 tasks x 2 arms x 3 repetitions (36 sessions). It was
  superseded on 2026-07-18 by the quota-cap amendment below.
- Execute inline and serialize all trial work; do not dispatch parallel agents or run concurrent Codex trials.
- Use identical task prompts, model, reasoning level, sandbox, timeouts, and verification between arms.
- The control arm must contain no Frontload MCP config, hooks, skill, state, or tool calls.
- The treatment arm must use the normal packed-package install and frontload init --agents codex path.
- Preserve the generated prompt-approval qualification as out-of-box evidence; primary treatment changes only default_tools_approval_mode to approve after init and is labeled an optimistic steady-state ceiling.
- Use Codex JSONL usage as primary token evidence; Frontload chars / 4 estimates are diagnostics only.
- Charge retries and fallbacks to the arm that caused them; preserve failed attempts.
- Charge one measured cold setup to the six-task corpus and report break-even separately.
- Do not remove or replace an unfavorable task or run.
- Make at most two repair attempts for the same repeated Frontload failure.
- Keep generated evidence under .frontload/audit/; do not expose auth contents.
- Do not modify Frontload product source, commit, push, open a PR, or publish during the audit.

## Quota-Cap Amendment (2026-07-18)

The developer stopped the original 36-session plan after it exhausted a weekly
Codex allowance and capped the full audit at two weekly allowances, with capacity
reserved for report follow-up. Finish with the 16 valid sessions already captured:
8 complete pairs across all 6 frozen tasks, including second repetitions for both
narrow tasks. Do not start another primary Codex session, synthetic failure trial,
or model-based scorer.

The final analysis uses every complete pair, deterministic hidden verification,
and a non-blind manual rubric review. It must disclose the smaller-than-planned
sample, the limited repeat coverage, and the distinction between measured Codex
tokens and subscription-quota debits. The original schedule and all invalid or
cancelled attempts remain preserved as evidence.

---

### Task 1: Freeze Environment and Dogfood the Exact Package

**Files:**
- Create: .frontload/audit/environment.json
- Create: .frontload/audit/package/frontload-0.3.1.tgz
- Modify: none outside ignored audit state and normal init state

**Interfaces:**
- Consumes: clean main equal to or descended from origin/main
- Produces: packed artifact, SHA-256, exact versions, and a passing dogfood doctor result

- [ ] **Step 1: Reconfirm the source baseline**

Run:

~~~bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git status --short
git rev-parse HEAD
~~~

Expected: ancestry exits 0; only the approved audit spec and plan are untracked.

- [ ] **Step 2: Build, pack, install, initialize, and diagnose**

Run:

~~~bash
pnpm build
mkdir -p .frontload/audit/package .frontload/dogfood
rm -f .frontload/audit/package/frontload-*.tgz .frontload/dogfood/frontload-*.tgz
npm pack --pack-destination .frontload/audit/package
cp .frontload/audit/package/frontload-*.tgz .frontload/dogfood/
npm install -g .frontload/audit/package/frontload-*.tgz
frontload init --repo . --agents codex --force
frontload doctor --repo . --dogfood
~~~

Expected: build and doctor exit 0; frontload --version is 0.3.1; doctor identifies the packed current checkout. Record durations and output bytes.

- [ ] **Step 3: Capture a redacted environment manifest**

Write environment.json with auditVersion, date, platform, arch, Frontload commit/version/package SHA-256, Codex version, model, reasoning effort, Node version, pnpm version, and npm version. Do not record usernames, home paths, auth tokens, or environment variables.

---

### Task 2: Materialize and Freeze the Six-Task Corpus

**Files:**
- Create: .frontload/audit/sources/p-map/
- Create: .frontload/audit/sources/vitest/
- Create: .frontload/audit/templates/<task-id>/
- Create: .frontload/audit/gold/<task-id>/
- Create: .frontload/audit/tasks.json

**Interfaces:**
- Consumes: public GitHub repositories and the checked-in React fixture
- Produces: agent-visible bases, agent-invisible gold files, exact prompts, verification, rubrics, timeouts, and hashes

- [ ] **Step 1: Fetch public source caches**

Run:

~~~bash
git clone --filter=blob:none https://github.com/sindresorhus/p-map.git .frontload/audit/sources/p-map
git clone --filter=blob:none https://github.com/vitest-dev/vitest.git .frontload/audit/sources/vitest
~~~

Run worktrees must be made with git archive into new repositories with no remote.

- [ ] **Step 2: Freeze these exact task manifests before paired runs**

Create tasks.json with:

| ID | Class | Base | Gold | Timeout | Verification |
|---|---|---|---|---:|---|
| pmap-index-order | narrow-fix | 65aaa8f4d7e757a5254a146c4c39403efa9e2139 | 1af51b57534b284ead73cca65f26b56bb9390768 | 20m | npm test; gold test.js overlay |
| fixture-tooltip-reconnect | narrow-fix | fixture at 6792693 | synthetic-cache-key-rubric-v1 | 20m | npm test; npm run typecheck |
| pmap-abort-signal | medium-change | 735d80e928f083c9399e5f741eb1b3cabd0ac1ba | 4875dee68524a42fabfaa13796fb9484c8c7bb89 | 35m | npm test; gold test.js overlay |
| pmap-iterable-api | medium-change | 136b08a35a3578f6f7ff288bc34cd30eebe0141e | 5c59528def9611406f7ad000d5f20fd598716f58 | 40m | npm test; gold test.js, index.test-d.ts, and assert-in-range.js |
| noisy-retry-delay | noisy-diagnosis | synthetic-noisy-v1 | synthetic-retry-exponent-v1 | 20m | npm test |
| vitest-browser-pretransform-review | read-only-review | 941bc836167d6c41ded609ed4819084d52dbb226 | b60605ca76c44b699d4d9153a5bd658c360c8dee | 20m | fixed answer rubric |

Prompts, verbatim:

1. Fix pMapIterable so the mapper index always reflects source order when input promises settle out of order. Preserve output ordering, concurrency, backpressure, and pMapSkip behavior. Add or update tests, run the relevant verification, and report the root cause. Do not use the network or inspect history outside the current commit.
2. Fix the stale chart tooltip value after a sensor reconnect. Preserve caching and existing public APIs, add or update tests where useful, run the relevant verification, and report the root cause. Do not use the network or inspect history outside the current commit.
3. Add AbortController support to pMap through an optional AbortSignal. Already-aborted and later-aborted signals must reject with an AbortError-compatible reason while preserving existing behavior without a signal. Update runtime code, TypeScript declarations, documentation, and tests, then run the relevant verification. Do not use the network or inspect history outside the current commit.
4. Add a pMapIterable async-iterable API. It must apply the mapper concurrently with configurable concurrency and backpressure, yield results in source order, omit pMapSkip values, accept sync or async iterables and promised values, and expose accurate TypeScript declarations and documentation. Do not add stopOnError or signal options to this API. Add tests and run the relevant verification. Do not use the network or inspect history outside the current commit.
5. CI's retry-policy test fails. Diagnose and fix the production behavior. Do not delete or skip tests and do not reduce the diagnostic logging. Run the test and report the root cause. Do not use the network or inspect history outside the current commit.
6. Do not edit files. Diagnose why browser projects now force preTransformRequests off after project/server unification. Identify every configuration site responsible, explain the required browser-versus-Node behavior, propose the smallest precise fix, and identify the regression coverage that should be added. Do not use the network or inspect history outside the current commit.

- [ ] **Step 3: Export immutable templates**

For public tasks, run git archive at each base into a fresh directory, initialize a new git repository, configure an invalid test identity, commit as benchmark base, and remove all remotes.

For the tooltip fixture, copy only fixtures/react-ts-app, change scripts to ordinary vitest and tsc commands, run npm install --ignore-scripts, and initialize the isolated repository.

For noisy-retry-delay, create:

~~~json
{"name":"noisy-retry-delay","version":"1.0.0","private":true,"type":"module","scripts":{"test":"node --test"}}
~~~

~~~js
// src/retry-delay.js
export function retryDelay(attempt, baseMs) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be a positive integer');
  return baseMs * (2 ** attempt);
}
~~~

~~~js
// test/retry-delay.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import {retryDelay} from '../src/retry-delay.js';

test('retry delay starts at the base delay and doubles', () => {
  for (let index = 0; index < 8000; index++) console.log('diagnostic worker=' + (index % 16) + ' item=' + index);
  assert.equal(retryDelay(1, 100), 100);
  assert.equal(retryDelay(2, 100), 200);
  assert.equal(retryDelay(4, 100), 800);
});
~~~

Its gold behavior changes only 2 ** attempt to 2 ** (attempt - 1).

- [ ] **Step 4: Prepare hidden gold and rubrics**

Extract only listed gold test files into .frontload/audit/gold/<task-id>/. Never copy them into an agent worktree before Codex exits.

Code rubrics score 0-4: root cause correct, production behavior complete, regression coverage present, and no forbidden shortcut/regression.

Vitest review criteria are exactly:
1. identifies packages/vitest/src/node/plugins/server.ts;
2. identifies packages/vitest/src/node/plugins/runnerTransform.ts;
3. explains browser mode must omit server.preTransformRequests and leave client.dev.preTransformRequests unset;
4. explains Node retains the disabled default and proposes browser/Node coverage in test/e2e/test/config/browser-configs.test.ts.

- [ ] **Step 5: Validate bases and gold**

Confirm tasks 1, 2, and 5 reproduce their target failure; task 6 contains all rubric sites; gold-overlay verification passes for tasks 1, 3, and 4. Store output, exit codes, and SHA-256. Fix arm-independent setup before trials; do not substitute tasks after trials begin.

The historical pMapIterable concurrency timing assertion may be retried exactly once only when it is the sole verifier failure; retain both attempts. This rule was frozen after gold commit `5c59528` missed its 200 ms lower bound by 0.135 ms once and passed unchanged on the immediate rerun.

---

### Task 3: Build the Isolated Runner and Qualify Telemetry

**Files:**
- Create: .frontload/audit/bin/audit-runner.mjs
- Create: .frontload/audit/qualification/
- Create: .frontload/audit/schedule.json

**Interfaces:**
- Consumes: tasks, templates, real auth.json by symlink, packed Frontload
- Produces: per-run homes/worktrees, JSONL, stderr, patches, Frontload events, metrics, parsed records

- [ ] **Step 1: Implement exact runner commands**

~~~text
node audit-runner.mjs qualify
node audit-runner.mjs schedule --seed 20260711
node audit-runner.mjs setup-benchmark
node audit-runner.mjs run --run-id <id>
node audit-runner.mjs verify --run-id <id>
node audit-runner.mjs failure-injection
node audit-runner.mjs analyze
~~~

Each record contains runId, taskId, arm, repetition, timestamps, durationMs, processExitCode, timedOut, input/cached/uncached/output/total tokens, Frontload tool calls/failures, fallback calls, verified, rubricScore, and evidence paths.

The parser fails closed if final turn.completed.usage is absent or inconsistent. It never infers primary tokens from characters.

- [ ] **Step 2: Isolate Codex homes identically**

For every run, create fresh HOME and CODEX_HOME=HOME/.codex, symlink only real auth.json, and write only the run worktree trust entry. Never print or copy auth contents.

Copy templates and verifier worktrees with verbatim symlink preservation. The
first control attempt exposed absolute `node_modules/.bin` rewrites, was archived
as invalid harness evidence before any treatment run, and must not enter primary
results.

Control precondition: no Frontload skill, hooks, project config, state, MCP listing, or call.

Treatment: with run HOME active, execute packed Frontload init --repo <worktree> --agents codex --force. Require project .codex/config.toml, isolated-home skill and hooks, and successful doctor.

Before each primary treatment session, replace exactly one generated `default_tools_approval_mode = "prompt"` with `"approve"`. Fail if zero or multiple settings match. Do not make this change in cold/default setup measurement.

- [ ] **Step 3: Invoke Codex identically**

Use an argument array:

~~~text
codex exec --json --ephemeral --strict-config --dangerously-bypass-hook-trust
  --model gpt-5.6-sol
  --config model_reasoning_effort="xhigh"
  --config sandbox_workspace_write.network_access=false
  --sandbox workspace-write
  --cd <worktree>
  <task prompt>
~~~

Redirect stdout to events.jsonl and stderr to stderr.log. On timeout send SIGTERM, wait five seconds, then SIGKILL. Preserve partial evidence and count failure.

- [ ] **Step 4: Generate fixed schedule**

Use seed 20260711. Shuffle only arm order within each task/repetition pair and interleave pairs round-robin. Store all 36 entries and SHA-256 before primary runs.

- [ ] **Step 5: Qualify telemetry and isolation**

In a scratch package confirm:
- control codex mcp list has no Frontload;
- treatment list has the project server;
- explicit treatment dossier prompt completes a Frontload MCP call;
- final usage is parseable and not double-counted;
- isolated hooks and skill load;
- network is unavailable in both arms;
- control trace contains zero Frontload calls.

Freeze parser after qualification. Repair isolation before primary trials if needed.

---

### Task 4: Measure Cold Setup, Warm Operations, and Failure Cost

**Files:**
- Create: .frontload/audit/setup/cold.json
- Create: .frontload/audit/setup/warm.json
- Create: .frontload/audit/failure-injection/

- [ ] **Step 1: Measure cold path**

On a fresh fixture and HOME, time init, doctor, fresh Codex start, first dossier, search, read, summarized test, and budget report. Capture output bytes, duration, status, RSS where available, and any Codex diagnostic tokens.

- [ ] **Step 2: Measure warm path**

Repeat dossier, search, read, and summarized test without deleting the index. Record Frontload event durations and visible sizes. Do not use these byte estimates as the primary outcome.

- [ ] **Step 3: Inject safe launch failure**

After init, prepend a temporary executable frontload shim that prints injected frontload launch failure and exits 70. Run one natural treatment task. Record detection, retries, fallback, tokens, and time. Restore by discarding the isolated environment.

---

### Task 5: Execute 36 Primary Sessions

**Files:**
- Create: .frontload/audit/runs/<run-id>/
- Modify: .frontload/audit/results.jsonl

- [ ] **Step 1: Run sequentially**

For each schedule entry, clone the template with APFS copy-on-write, create isolated HOME, assert arm preconditions, run Codex, capture metrics, and hash evidence. Never resume or reuse home/worktree.

- [ ] **Step 2: Verify after Codex exits**

Copy hidden gold test overlays into a disposable verifier copy and run manifest commands. Preserve agent test output and hidden verification. Never let later success erase earlier cost.

- [ ] **Step 3: Apply stop rules**

Timeouts count as failures. Destructive behavior stops the affected experiment. Inspect Frontload budget before a second repair and stop after two. Do not change schedule based on interim tokens.

---

### Task 6: Blind Score, Analyze, and Document Issues

**Files:**
- Create: .frontload/audit/scoring/blinded/
- Create: .frontload/audit/analysis/results.json
- Create: proof/codex-net-benefit-audit.md
- Create: proof/frontload-audit-issues.md

- [ ] **Step 1: Blind rubric inputs**

Assign opaque randomized labels to final answer plus patch. Exclude arm, tokens, tool traces, and paths. Score fixed 0-4 rubrics, then unblind. Keep objective verification separate.

Use a fresh control-isolated Codex process as the scorer, with the same model and reasoning effort but access only to the rubric and opaque bundle directory. The scorer must not have Frontload, the run schedule, result metadata, or repository remotes. Record scorer tokens as audit overhead, never as either experimental arm. Reject scorer output unless it returns one integer per rubric criterion plus a short evidence citation from the opaque bundle.

- [ ] **Step 2: Analyze without dropping failures**

Report all runs, task medians/ranges/IQR, paired total-token difference and percentage, token components, completion, rubric difference, failures, fallbacks, and wall time. Bootstrap paired differences by task and repetition with seed 20260711 for 10,000 samples.

Compute:

~~~text
six-task net = treatment task tokens + one cold setup token cost - control task tokens
break-even tasks = one-time setup token cost / median successful paired per-task saving
~~~

If saving is non-positive, break-even is undefined.

- [ ] **Step 3: Write stable report**

proof/codex-net-benefit-audit.md includes environment, exclusions, corpus, schedule hash, setup, all 36 rows, task-class analysis, failure injection, amortization, verdict, limitations, and reproduction commands.

- [ ] **Step 4: Write issue log**

proof/frontload-audit-issues.md starts with established measurement gaps and adds every observed runtime problem. Each entry has ID, severity, version/commit, environment, context, expected, observed, reproduction, frequency, token/time impact, workaround, evidence, and supported component. Causes are hypotheses. Exclude the Codex manual-helper failure because it is not Frontload.

---

### Task 7: Fresh Verification and Handoff

**Files:**
- Verify: docs/superpowers/specs/2026-07-11-codex-net-benefit-audit-design.md
- Verify: docs/superpowers/plans/2026-07-11-codex-net-benefit-audit.md
- Verify: proof/codex-net-benefit-audit.md
- Verify: proof/frontload-audit-issues.md

- [ ] **Step 1: Validate completeness**

Require exactly 36 primary records, 18 per arm, 6 per task, and 3 per task/arm, plus setup and failure records. Recompute hashes and analysis from raw JSONL.

- [ ] **Step 2: Re-run product verification through Frontload summaries**

~~~bash
pnpm lint
pnpm build
pnpm test
pnpm e2e
node dist/src/cli/index.js validate-plugins --repo .
~~~

No product source should have changed.

- [ ] **Step 3: Review diffs and requirements**

Use fl_git_diff_summary. Confirm only approved docs/reports changed. Check every design requirement and scan for placeholders, secrets, private absolute paths, and unsupported causes.

- [ ] **Step 4: Deliver without committing**

State Positive, Negative, or Inconclusive under the frozen rule. Lead with numerical net and correctness. Link report, issue log, spec, and plan. Do not commit or push without explicit instruction.
