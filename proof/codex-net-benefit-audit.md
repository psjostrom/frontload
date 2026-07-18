# Frontload Codex Net-Benefit Audit

Date: 2026-07-18

Scope: Frontload 0.3.1 with Codex CLI on macOS arm64

## Final judgment

**Frontload 0.3.1 is net negative for Codex. Stop using and shipping the current
Codex integration.**

Across 8 complete A/B pairs, plain Codex used 3,660,058 total tokens and
Frontload used 5,854,651 for the same 8/8 verified completion and the same 31/32
manual rubric score. Frontload therefore added **2,194,593 tokens (+59.96%)** and
**535,296ms (+31.85%)**. Removing Frontload would have reduced tokens by 37.48%
relative to the measured treatment workload.

This is not a marginal miss and setup amortization cannot reverse it. Frontload
was worse in 6 of 8 pairs, had a practical greater-than-10% saving in only 1 of
8, failed once per treatment run on average, and has critical wrong-repository
failure modes. The current MCP/dossier/skill architecture is not suitable for
incremental polishing.

The project is **salvageable only as an architectural reset with a hard kill
gate**. The reusable assets are the audit harness, corpus, command-filtering
knowledge, and perhaps the name. The normal Codex MCP workflow should be deleted,
not tuned. If that reset is not acceptable, disband/archive Frontload and use
plain Codex while evaluating RTK. Caveman is at most an optional small output
optimization; it does not address the dominant cost found here.

## Primary result

Codex JSONL `input_tokens + output_tokens` is the primary measurement. Cached
input is included in total and also reported separately.

| Arm | Runs verified | Input | Cached input | Uncached input | Output | Total | Wall time |
|---|---:|---:|---:|---:|---:|---:|---:|
| Plain Codex control | 8/8 | 3,600,243 | 3,200,000 | 400,243 | 59,815 | 3,660,058 | 28m 0.8s |
| Frontload treatment | 8/8 | 5,787,605 | 5,331,200 | 456,405 | 67,046 | 5,854,651 | 36m 56.0s |
| Frontload minus control | — | +2,187,362 | +2,131,200 | +56,162 | +7,231 | **+2,194,593** | **+8m 55.3s** |

Frontload increased cached input by 66.60%; cached input accounts for 97.11% of
the excess total. This is consistent with extra tool turns repeatedly carrying
the session context. It is not only a cached-token accounting artifact: excluding
cached input, control used 460,058 uncached-input-plus-output tokens and Frontload
used 523,451, an increase of **63,393 (+13.78%)**.

The treatment trace contains 153 Frontload tool calls and 8 failed Frontload
calls. After the first Frontload failure in each affected trace, the frozen
parser counted 38 subsequent raw command calls. That heuristic demonstrates a
large post-failure raw path but does not claim all 38 were one-to-one retries.
Control contains no Frontload tool calls.

### Complete pair table

Positive differences mean Frontload used more tokens.

| Task | Class | Rep | Control | Frontload | Difference | Difference % | Both passed |
|---|---|---:|---:|---:|---:|---:|---:|
| Tooltip reconnect | narrow fix | 1 | 136,423 | 173,135 | +36,712 | +26.91% | yes |
| Tooltip reconnect | narrow fix | 2 | 124,942 | 308,630 | +183,688 | +147.02% | yes |
| Noisy retry delay | noisy diagnosis | 1 | 195,325 | 195,001 | -324 | -0.17% | yes |
| pMap abort signal | medium change | 1 | 1,361,966 | 1,054,363 | -307,603 | -22.59% | yes |
| pMap index order | narrow fix | 1 | 168,722 | 517,091 | +348,369 | +206.48% | yes |
| pMap index order | narrow fix | 2 | 287,207 | 821,359 | +534,152 | +185.98% | yes |
| pMap iterable API | medium change | 1 | 684,472 | 1,097,491 | +413,019 | +60.34% | yes |
| Vitest configuration review | read-only review | 1 | 701,001 | 1,687,581 | +986,580 | +140.74% | process yes; rubric 3/4 each |

The paired median difference is +266,028.5 tokens; the range is -307,603 to
+986,580 and the IQR is 415,849.25. A seeded 10,000-sample task-stratified
bootstrap gives +192,540.5 to +298,353.5 around the observed paired median.
Because four task classes have only one repetition, that interval is conditional
on this frozen corpus and cannot be treated as population-level confidence. An
exact one-sided sign test on the 6 harmful versus 2 beneficial directions gives
`p = 0.145`; the small sample cannot prove a universal harm rate from direction
alone. The measured aggregate, the large effects, and the reliability failures
are nevertheless sufficient for a product decision on the tested version.

## Correctness and quality

All code runs passed the same hidden, arm-independent verification. After the
quota cap, final messages, patches, hidden results, and the frozen rubrics were
reviewed manually instead of spending another Codex session on a scorer.

- Control: 31/32 rubric points.
- Frontload: 31/32 rubric points.
- Difference: 0.

Both Vitest review answers found the two responsible configuration sites and the
right test location, but both proposed setting the browser values to `true`.
The frozen answer key and gold change require leaving the browser values unset;
each arm therefore lost the same point. There is no observed quality advantage
that could justify Frontload's cost.

The manual reviewer knew arm labels and token results, so this quality assessment
is not blind or independent. The per-run record is in
`.frontload/audit/analysis/manual-quality-review.json`.

## Setup, default behavior, and amortization

The primary treatment is an optimistic ceiling. Literal `frontload init`
generated `default_tools_approval_mode = "prompt"`; in a noninteractive Codex
session, 2 of 2 MCP calls were cancelled and Codex fell back to raw tools. For the
primary trials only, the generated mode was changed to `"approve"` after init.

Two trivial package-name qualifications show the recurring workflow cost:

| Qualification | Control | Frontload | Increment |
|---|---:|---:|---:|
| Literal initialized default with cancelled MCP calls | 23,882 | 77,428 | +53,546 |
| Clean pre-approved workflow, no Frontload failure | 23,745 | 79,729 | +55,984 |

The clean treatment sequence was only skill read, dossier, and budgeted read.
It still used 3.36 times the control tokens to return one package name.

The direct cold setup/workflow took 6.803s, emitted 13,197 stdout bytes, and
peaked at 281.4MiB RSS. The repeated warm workflow took 2.011s, emitted 12,188
stdout bytes, and peaked at 173.1MiB. Two budget reports emitted 4,826 and 7,880
bytes—about 3,177 tokens at Frontload's own four-characters-per-token estimate.
A budgeted read of a 191-byte source file emitted 736 bytes and modeled a
negative 545-byte saving on both cold and warm runs.

Charging the literal-default +53,546-token increment to the first complete
six-task corpus raises Frontload's disadvantage from 1,476,753 to 1,530,299
tokens. Since the observed recurring per-task saving is negative, mathematical
break-even is undefined. More use makes the loss larger rather than amortizing
setup.

## Why Frontload lost

The evidence supports this causal hypothesis:

1. Frontload asks the model to read a skill and choose among nine MCP tools.
2. Normal work becomes additional dossier, policy, search, budgeted-read,
   summarized-command, diff-summary, and budget-report turns.
3. Each turn carries or reuses a large session context. Treatment cached input
   rose by 2.13 million tokens.
4. The Frontload calls did not fully replace normal commands. After the first
   Frontload failure in affected traces, 38 later raw command calls remained.
5. Codex already bounds many file and command results. On the deliberately noisy
   8,000-line task, Frontload's byte model claimed roughly 240KB saved, but actual
   end-to-end Codex tokens improved by only 324 (0.17%) and wall time worsened by
   12.2s.

The traces establish the association and mechanism; they do not isolate the
token cost of each individual tool turn. That isolation is unnecessary for the
ship decision because the integration must succeed as a whole.

## Reliability findings

The full reproduction details and evidence paths are in
[`frontload-audit-issues.md`](frontload-audit-issues.md). The most important are:

- a command hook can execute a nested-repository command in the wrong repository;
- a live MCP server can remain silently bound to the prior worktree;
- the initialized approval default cancels unattended MCP calls;
- the command policy rejected 7 normal targeted commands across 5 of 8 treatment
  runs;
- the large-repository dossier timed out after 120 seconds;
- concurrent summaries can select the same log path;
- budget reporting adds recurring model-visible output;
- dirty-tree packaging can include untracked allowlisted files.

The wrong-repository defects independently fail Frontload's promise of invisible,
normal-flow behavior even if token economics improved.

## Salvage or disband

### Decision

Do not salvage the current architecture incrementally. Mark the Codex integration
stop-ship now.

Allow exactly one salvage attempt only if the team accepts that it is a rewrite.
If the following architecture or kill gate is rejected, disband/archive the
project. Keeping the MCP/dossier-first workflow because it already exists would
be sunk-cost reasoning.

### Minimum salvage architecture

1. **Remove the default Codex MCP server, tool schemas, skill read, dossier,
   index, and model-visible budget report.** Plain Codex search/read remains the
   default.
2. **Compress in the same shell call.** Provide a small fail-open command wrapper
   for selected high-output tests/builds/lints. It must not require a preliminary
   tool call, policy lookup, or retry turn.
3. **Activate only above an output threshold.** Short commands and file reads
   pass through byte-for-byte. Save full failed output locally and return a
   compact error-focused view plus an exact path for optional expansion.
4. **Use the shell's actual working directory.** Remove captured absolute repo
   bindings. On any internal error, execute and return the original command in
   the same call.
5. **Remove Frontload's command allowlist.** Codex/harness permissions remain the
   security boundary; Frontload must not reject ordinary repository-local test
   commands.
6. **Keep accounting offline.** Record bytes and latency locally. Do not put
   reports in model context unless the developer explicitly asks.
7. **Do not restore dossiers or indexed reads until the command-only product is
   independently net positive.** The one strong win on the abort-signal task
   shows selective compaction can help; it does not validate the broader stack.

### Hard kill gate

Do deterministic filter tests first; they spend no model quota. A future Codex
screening suite must be capped at 6 frozen tasks x 2 arms x 1 repetition: 12
sessions maximum, with no separate model scorer. Do not spend the remaining quota
from this audit on it.

Revive Frontload only if the rewrite meets every condition:

- at least 10% lower aggregate Codex total tokens after charged setup;
- no task class more than 5% worse;
- identical hidden verification and manual rubric result;
- zero wrong-repository, timeout, denial, approval, or retry-turn failures;
- no wall-time regression overall;
- the result remains positive when cached input is excluded.

Stop early and archive if the first three complete pairs are all harmful or the
aggregate harm exceeds 10%. If the full 6-pair screening misses any gate, disband
rather than starting another repair/measurement loop.

## Alternatives

### Plain Codex

Use plain Codex now. It is the only alternative directly validated by this audit,
and it produced the same quality with 2.19 million fewer tokens. Standard bounded
search/read and normal targeted commands should remain the baseline.

### RTK

RTK is the best candidate for the first replacement evaluation because it can
filter a command inside the same shell call instead of adding an MCP dossier turn.
However, its current Codex integration is **not transparent**: RTK's official
supported-agent documentation classifies Codex as an `AGENTS.md` rules-file
integration that relies on the model following instructions. Transparent command
rewrites are available for other agents, not Codex. Its claimed 60–90% reductions
are command-output estimates, not evidence of end-to-end Codex quota savings.
There are also open Codex-specific support reports. Treat RTK as a hypothesis and
run the same capped A/B screen before standardizing it.

Sources: [RTK repository](https://github.com/rtk-ai/rtk),
[official supported-agent guide](https://github.com/rtk-ai/rtk/blob/master/docs/guide/getting-started/supported-agents.md),
[Codex support issue](https://github.com/rtk-ai/rtk/issues/1237).

### Caveman

Caveman mainly compresses agent prose. Its repository claims roughly 65–75%
output-token reduction, while an independent paired benchmark measured 8.5% on
agentic tasks even when forced on. In this audit, all control output was only
1.63% of total tokens. Even an impossible 100% elimination of output would not
offset Frontload's 59.96% increase. Caveman may make final replies terser, and
shorter replies can reduce later context slightly, but it is not a substitute for
removing extra tool turns. Use it only after a small Codex-specific A/B check and
do not install its broader MCP compression features without separate measurement.

Sources: [Caveman repository](https://github.com/JuliusBrussee/caveman),
[JetBrains paired evaluation](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/).

## Method and quota cap

The frozen corpus contains six tasks spanning narrow fixes, medium changes, a
noisy failure, and a read-only architecture review. Public historical snapshots
come from p-map and Vitest; two controlled fixtures cover tooltip caching and
8,000-line noisy output. Each arm started from a byte-identical fresh repository.
The control had no Frontload configuration, state, skill, hook, MCP listing, or
calls. The treatment used the packed normal install/init path and a new Codex
process. Prompts, model, `xhigh` reasoning, permissions, timeouts, and hidden
verification were identical. Arm order was randomized with seed 20260711.

The original plan specified 36 primary sessions. It exhausted a weekly allowance
before completion. On 2026-07-18 the developer capped the entire audit at two
weekly allowances and required capacity for report questions. Collection stopped
at 16 valid sessions/8 complete pairs covering every frozen task class, with two
repetitions for both narrow tasks. One in-progress control without a final usage
event was cancelled, archived as invalid, and excluded. No completed pair was
discarded and no unfavorable task was removed.

Known child-session telemetry consumed by the audit is at least 10,405,735 total
tokens: 9,514,709 in valid primary runs, 686,242 in two completed invalid runs,
and 204,784 in completed qualification runs. Quota-only rejections, the cancelled
run without final usage, and this interactive audit task have no comparable final
telemetry and are excluded from that lower bound. This cost is itself evidence
that the original design was too heavy.

Codex subscription quota accounting is not public in the captured events and may
weight cached input, model effort, or elapsed compute differently. The report
therefore does not claim that one JSONL token equals one quota unit. It does claim
that the treatment caused many more reported tokens and longer sessions while the
actual audit repeatedly hit the account limit.

The reduced repetition count, non-blind manual review, old frozen Codex CLI, one
model/reasoning level, macOS-only environment, and six-task corpus limit
generalization. They do not rescue the tested release: it fails the preregistered
negative criterion on observed net tokens and normal-flow reliability.

## Frozen environment and evidence

- Frontload commit: `318b17f832b7b0d6e152a073b3e4b36715a6654f`
- Version: 0.3.1
- Packed artifact SHA-256:
  `38959c2d2f6387ad4e228fc247a55a24599ec97a50a375ba46c051d21c5f312c`
- Codex CLI: 0.144.1
- Model: `gpt-5.6-sol`, `xhigh`
- Node: 26.3.0; pnpm: 10.14.0; npm: 11.16.0
- Platform: macOS arm64

Bulky raw evidence is intentionally ignored under `.frontload/audit/`. Important
machine-readable files are:

- `.frontload/audit/environment.json`
- `.frontload/audit/corpus-manifest.json`
- `.frontload/audit/tasks.json`
- `.frontload/audit/schedule.json`
- `.frontload/audit/results.jsonl`
- `.frontload/audit/invalid-results.jsonl`
- `.frontload/audit/analysis/results.json`
- `.frontload/audit/analysis/manual-quality-review.json`
- `.frontload/audit/runs/<run-id>/events.jsonl`
- `.frontload/audit/runs/<run-id>/verification.json`
- `.frontload/audit/runs/<run-id>/changes.diff`

Minimal integrity checks:

```bash
node --test .frontload/audit/bin/audit-runner.test.mjs
jq -e '.validRuns == 16 and .validPairs == 8' .frontload/audit/analysis/results.json
jq -e '.summary.controlPoints == .summary.treatmentPoints' \
  .frontload/audit/analysis/manual-quality-review.json
shasum -a 256 .frontload/audit/package-clean/frontload-0.3.1.tgz
git diff --check
```

No product source was changed, committed, pushed, or published during this audit.
