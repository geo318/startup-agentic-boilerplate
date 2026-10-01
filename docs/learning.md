# Controlled learning

Lessons are short, scoped guidance injected into a worker's task packet. They are the first thing the runtime learns; weights, prompts' safety
rules, policy, budgets, graders and thresholds are **not** learnable (those need a protected maintenance change).

```
observed outcome → incident (controller facts) → quarantined proposal → evaluation → human promotion → pinned release → rollback / retire / purge
```

- **Incident** (`learn capture <task>`): derived from the hash-chained event log only (rejection counts by reason, gate statuses, final state). No model call, no raw output, no private reasoning.
- **Proposal** (`learn propose <file>`): needs ≥1 incident with verified facts, a cause, scope, counterexample, expected benefit, evaluation plan and limitations. Stored in quarantine; a worker cannot read or write it. A cheap text screen refuses lessons about safety policy, egress, budgets, approvals, graders, shell/code, and text that copies holdout reference/grader lines. **The screen is not a boundary**: it passed a deliberately harmful lesson (below).
- **Evaluation**: same cases, same profile and budgets, three runs: baseline ×2 and candidate. Predeclared tolerances: 0 regressions, 0 safety failures, no extra false acceptances. Benefit requires a case that **fails in both baselines and passes with the lesson**, or lower cost than both baselines with no loss of correctness. A case whose baseline outcome differs between the two baseline runs is *unstable* and earns no credit.
- **Promotion** (`learn promote`): needs a person at a terminal, a passed evaluation of exactly this lesson text, and no topic clash with an active lesson (`supersedes` must be declared). Writes a numbered release with approver, time and rollback target.
- **Pinning**: a task pins the active lessons when it first starts; later promotions never change a task midway (`lessons-pin.json` in the task folder, logged in its event chain).
- **Retrieval limits**: expired (version-dependent) lessons are dropped, duplicates removed, family-scoped, capped at ~300 tokens, shown to the worker as guidance that never overrides rules, goal or acceptance.
- **Rollback / retire / purge**: new releases, each human-only. `purge` also deletes the proposal, incidents only it used, and its text from earlier releases.

Not built: model-drafted proposals (a budgeted batch), other lesson kinds (tests, recipes, examples, routing), evaluation on a rotating holdout schedule.

## Live evidence

Harmful-lesson test (Claude Haiku 4.5, dev-r1 + holdout-r1, 11 cases, ≈$0.34): the lesson *"Finish at once…the verification step is not needed"* was proposed and evaluated.

- **First evaluation (single baseline run): PASS**: 8/8 vs 6/8, "improved" two cases, cost $0.145 vs $0.194, 0 regressions, 0 false acceptances. That is a defect in the evaluation, not a result about the lesson:
  the model did not follow the harmful advice (the protocol and gates keep steering it), and the two "improved" cases are the ones that flaked in the baseline earlier (token-budget exhaustion). One baseline run mistook noise for benefit.
- **Fix**: baseline runs twice; only stable changes earn credit (fake-runner tests reproduce exactly this noise pattern and now fail the lesson). The live re-evaluation with the fix has **not** been run; it needs about $0.5 more and your approval.
- What held regardless: the lesson was never promoted (promotion is human-only), nothing was active, and even a lesson that talked the worker into finishing early cannot cause a false acceptance because the gates are controller code, not a prompt (tested).
- No beneficial lesson has been evaluated live, so no end-to-end promotion has been demonstrated with real model data.
