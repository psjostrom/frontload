# Agent Budget Token Cost Trial: Strimma and Springa

Date: 2026-06-09

This report records a local trial of `agent-budget` against two sibling repos:

- `/Users/psjostrom/code/strimma`
- `/Users/psjostrom/code/springa`

The comparison uses recent feature/fix commits as feature-sized work units. Token counts use the same estimate as `agent-budget`: `chars / 4`.

## Method

For each feature, the `agent-budget` path was modeled as:

1. Generate a task dossier.
2. Run indexed search when the dossier was too broad.
3. Read a small set of budgeted file excerpts.
4. Run a summarized verification command where applicable.

The "without agent-budget" baseline is the cost of loading all files changed by the feature commit into agent context. A patch-only baseline is also included because some agents inspect patches instead of full files.

The one-time `index` operation is reported separately. The current CLI event logger records the full internal index result as output, so the budget report overstates visible index context. Treat index as setup/amortized cost, not per-feature context.

## Verification Notes

Tests did not complete in this environment:

- `strimma`: `./gradlew testDebugUnitTest` failed immediately because no Java runtime is installed.
- `springa`: `npm test` reached `vitest run`, but `vitest` was not installed in the checkout.

Those failed command summaries were still useful for measuring command-summary overhead, but they are not passing test evidence.

## Indexed Repo Size

| Repo | Indexed files | Indexed bytes | Logged index tokens |
|---|---:|---:|---:|
| strimma | 349 | 2,425,445 | 41,252 |
| springa | 393 | 2,707,224 | 67,338 |

## Per-Feature Cost

| Repo | Feature | Commit | With agent-budget | Without, full changed files | Savings | Patch-only baseline |
|---|---|---:|---:|---:|---:|---:|
| strimma | Data retention + Story month navigation | `fab2660` | ~7,114 | ~123,987 | ~94.3% | ~23,193 |
| strimma | CamAPS pump-only Attempting freshness fix | `577e9bf` | ~6,678 | ~7,898 | ~15.4% | ~7,226 |
| springa | Remove bonus/optional run concept | `20f4557` | ~9,399 | ~665,042 | ~98.6% | ~728,309 |
| springa | Cap fuel-rate recommendations | `e61075e` | ~5,723 | ~21,743 | ~73.7% | ~3,105 |
| springa | BG response mmol/hr + longest-run coach context | `369b597` | ~6,439 | ~19,849 | ~67.6% | ~7,546 |
| springa | Drop `workout_event_prescriptions` cache, derive grams live | `5ce66a3` | ~5,701 | ~43,571 | ~86.9% | ~17,926 |

## Repo Totals

Excluding one-time index setup:

| Repo | With agent-budget | Without, full changed files | Savings |
|---|---:|---:|---:|
| strimma | ~13,792 | ~131,885 | ~89.5% |
| springa | ~27,261 | ~750,205 | ~96.4% |

Including the currently logged index cost:

| Repo | With agent-budget + logged index | Without, full changed files | Savings |
|---|---:|---:|---:|
| strimma | ~55,044 | ~131,885 | ~58.3% |
| springa | ~94,599 | ~750,205 | ~87.4% |

## Observations

`agent-budget` works best on broad changes with many touched files or noisy generated/demo data. The clearest win was springa's optional-run removal because `lib/demo/fixtures.ts` dominated raw context.

It is less impressive on narrow fixes. The strimma CamAPS fix touched only five files, and the dossier/search ranking was noisy, so the measured savings were modest.

The current ranking has quality issues. Generic terms such as `run`, `story`, `settings`, and `constants` pulled in noisy docs and tests. The budgeted reads still constrained context, but relevance would improve with better term weighting, file-type weighting, and deprioritizing long docs unless the prompt explicitly asks for documentation.

The index logging should be adjusted. The visible CLI output is a compact summary, but the event log records the full index object, inflating setup cost in `agent-budget budget`.
