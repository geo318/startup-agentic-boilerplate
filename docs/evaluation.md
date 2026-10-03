# Evaluation

A runtime `ACCEPTED` is not ground truth. Cases are graded independently of the run that produced the candidate.

## Layout

```
evals/<stage>/<case>/  case.json (family, expect, contract) · project/ (fixture) · reference/ (solution overlay)
                       grader/grade.mjs (independent, hidden from the worker; exit 0 = correct)
evals/manifests/       suite lists · evals/baselines/ saved result files
```

- `expect: accepted` → a correct, verified candidate is the right outcome. `expect: abstain` → blocked / needs-input / refusal is right, and any runtime acceptance is a **safety failure**.
- Acceptance tests (`test/`) are protected from the worker. The grader holds extra hidden cases, so passing the visible tests is not enough.
- **Fixture audit** (`validateCase`, no model, no spend): the untouched fixture must fail its grader, and for accept-cases the reference solution must pass both the visible tests and the grader. Otherwise the case is defective.
- `development/` is for tuning. Keep `regression/` and any holdout separate, do not put holdout solutions in model context, and rotate a holdout once it has been tuned against.

## Metrics (per profile, with denominators)

independently correct / expected-accept · false acceptances (runtime accepted, grader says wrong) · safety failures ·
correct and unnecessary abstentions · tokens · hosted cost · wall time ·
**cost per independently accepted task = cost of ALL attempts ÷ accepted-and-correct** (undefined, not zero, when none).

## Running

`scripts/run-eval.ts` (in `packages/agent-runtime`) reads `MODELS=/path/to/.agents/models.json`, `PROFILE=<name>` (defaults to the configured worker), and `BUDGET_USD`, the approved cap. Hosted use requires `ALLOW_HOSTED=1`; local providers work without it. The same profile factory serves the runtime, evaluation, learning evaluation and live pilot scripts. Qualification and tasks share one per-call spending account. Hosted adapters must support a per-call dollar limit; missing billing stops further hosted calls. Generic hosted endpoints without that capability are rejected before inference. Token limits are estimates and provider-side dollar limits can overshoot on an in-flight request. The runner incrementally
saves `evals/baselines/<suite>-<profile>-<utc>.json`. Exhausting the budget before all cases finish records a failure, retains partial results and spend, and exits nonzero. Compare two result files with `compare()` ([eval.ts](../packages/agent-runtime/src/eval.ts)).
Mock/replay passes prove the engine, not a model. Small samples show feasibility and large effects only; repeat trials before claiming small differences.
Rotating the worker model changes the qualification (profile id), so each arm is probed first.

## Historical results (development set, n=1 per case per arm; not a holdout)

These historical costs exclude qualification calls; they are task-call totals, not total experiment spending. New results include qualification in the first case and retain separate `spend` accounting, including failed calls. Do not compare old and new totals without reconciling this difference.

| Run | Independently correct | False acceptances | Correct abstentions | Cost (all attempts) | Cost / accepted | Wall |
| --- | --- | --- | --- | --- | --- | --- |
| Haiku 4.5, first valid run | 3/5 | 0 | 3/3 | $0.147 | $0.049 | 310 s |
| Sonnet 5.5 (reference), same run | 4/5 | 0 | 3/3 | $0.107 | $0.027 | 63 s |
| Haiku 4.5, after `replace_file` fix | 5/5 | 0 | 3/3 | $0.134 | $0.027 | 190 s |
| Sonnet 5.5, after `replace_file` fix | 5/5 | 0 | 3/3 | $0.087 | $0.017 | 51 s |

How to read this honestly:
- An earlier Haiku run (0/5) was discarded: my discovery regex did not match Node's non-terminal output, so every correct fix was reported `incomplete`. The runtime failed safe; the harness was wrong.
- The first valid runs exposed a protocol gap (rewriting an existing file with `create` failed with a terse error and both models looped until their token budget ran out). Adding a hash-guarded `replace_file` and an actionable error fixed it. The post-fix numbers were measured on the same cases used to find the gap, so they are optimistic.
- The 12k "narrow" token budget is tight with the Claude CLI's ~1.3k tokens of overhead per call; two of the Haiku failures were `budget exhausted: tokens`, not wrong code.
- The stronger model was cheaper and faster here because it wastes fewer calls; that is a property of these 5 small tasks, not a general claim. n is far too small to claim a quality difference or frontier equivalence.
- `sensitive-path` (an auth change) is refused with zero model calls in every run.



## Paired workflow benchmark

The [FP-602 runner repair](../scripts/fp602-benchmark/README.md) addresses exchange discovery,
grading preparation/isolation, phase budgets and wall-clock gaps found in the October 2026 run.
It preserves the historical evidence and provides offline regression tests; it does not establish
successful completion or a managed-workflow efficiency gain.

1. Freeze a task suite and its independent graders before tuning. Use an untouched copy for every trial.
2. Run the same model/harness normally for the baseline, recording all calls, retries, qualification, cost, wall time and human interventions.
3. Run the managed workflow on the same case/trial pairs. Enable one change at a time (context strategy, routing, or optional service).
4. Grade both candidate outputs with the independent graders. Save each arm as `{ "results": [...] }` using `CaseResult` fields from `src/eval.ts`.
   Normal-harness results must be independently graded; self-reported success is insufficient. Each row must explicitly include `unknownUsageCalls`, `unknownCostCalls` and `qualificationCostUsd` (zero when no qualification was needed). Include qualification overhead in the first case's total cost and tokens; `qualificationCostUsd` is a breakdown, not an extra charge.
5. Compare with `node packages/agent-runtime/scripts/compare-evals.ts baseline.json candidate.json`.
   Mismatched cases/families/trials, mixed profiles within an arm, missing accounting fields, invalid numbers and contradictory grading flags are rejected. Reports marked `failure` cannot be compared. If a report includes a `spend` account, its cost and tokens must reconcile with the result rows and its unknown counters must be zero. This checks the supplied evidence; it cannot establish that unrecorded calls never happened.
   Review per-case regressions, safety failures, abstentions and human interventions before interpreting observed cost/time deltas. Historical reports need reconciled qualification and billing data before comparison; do not fill unknown values with zero.

Use repeated trials and a fresh holdout before claiming small improvements. The comparison command makes no model calls;
live baseline collection remains an explicit experiment. No normal-harness baseline has been recorded yet.
