# Jev Decision Fabric (optional)

Jev (TypeSafe) is used only for bounded **Choice** decisions among options the rules already allow. It never writes code, creates tools,
waives gates, lowers risk, changes budgets, permits egress, approves code, or promotes lessons. Everything below is off by default.

```
deterministic filter → allowed candidates → [Jev Choice] → deterministic resolver
```

## Automatic use when a key exists

With `JEV_API_KEY` in the user-level secrets store and no `jev.modes` in the policy, Jev turns on with: `workflow-select` = `enabled`, `skill-select` = `shadow`.
These defaults cannot change what a run does today: an enabled decision acts only when a calibration exists for that family (none does until labelled data does), and shadow never acts.
`jev.auto: false` opts out; explicit `jev.modes` always wins. The project's `egress` still gates sending: with `local-only`, `agentic doctor` reports "key present but NOT used".
What would be sent: the task goal, acceptance criteria, file names, risk tier and skill descriptions, never source.

## Behaviour

| Mode | What happens |
| --- | --- |
| `disabled` (default) | Rules only. No call, no telemetry. |
| `shadow` | Jev is called and recorded; the run does exactly what it would without it. |
| `enabled` | Jev's choice is used only if it is an allowed option, a calibration exists for that family, and confidence ≥ the calibrated threshold. Otherwise the rules' default. |

- Every question also offers `other`, `unknown`, `need_more_context`; choosing one falls back to the rules.
- Timeout, invalid response, unavailable credential, or a model that is not the pinned revision → rules fallback, recorded. Never fewer checks.
- The response is validated: exact option set, finite probabilities in [0,1] summing to ≈1, choice = argmax, confidence in range, no unexpected answers.
- `confidence` is a statistic of the distribution's shape, not a measured probability of being right. Thresholds come from `agentic jev calibrate` per family
  (needs ≥30 labelled decisions, ≥95% accuracy at-or-above the threshold) and are never hardcoded. With too little data the threshold is `none` and Jev cannot act.
- Telemetry (`$AGENTIC_HOME/telemetry/jev.jsonl`) stores raw probabilities, resolved model, calibration id, tokens, latency, and a **hash** of the evidence, not the evidence.
- Hosted calls need policy `egress: hosted-allowed`. Families that send source need `jev.allowSource: true` as well. The credential lives in `$AGENTIC_HOME/secrets.env` (mode 0600, never in a project).

## Families

| Family | Sends | Consumer today |
| --- | --- | --- |
| `workflow-select`: standard worker vs ask-for-clarification | goal, acceptance, file names, tier | Enabled → stops with `NEEDS_INPUT` *before* any model call (more human involvement, never fewer checks). Skipped for R0 recipes and R3. |
| `skill-select`: which workflow skills a task needs | the same + skill descriptions | None yet → shadow only (enabling is refused). |
| `retrieval-rerank`: which omitted files to include | file excerpts | None yet → shadow only; also needs `allowSource`. |

Not built: tool steering, pre-tool judgment, failure triage, context compaction, browser navigation. Each needs a consumer and a measured benefit first.

## Config

```json
// .agents/policy.json
"jev": { "modes": { "workflow-select": "shadow" }, "allowSource": false, "pinnedModel": "jev-1.13.0", "timeoutMs": 10000 }
```
`agentic jev status | report | calibrate --family <f> --labels <file>`. `model` defaults to the alias `jev-latest`, which moves; the resolved version is recorded
per decision and `pinnedModel` makes a different version fall back to rules.

## Evidence so far (synthetic dev-r1 cases, 7 distinct prompts × 3 trials; not independent samples)

- `workflow-select`: 21/21 agreement with the case labels (2 abstain-expected cases → `ask-clarification`, 5 accept-expected → `standard-worker`); 0 failures; one resolved model (`jev-1.13.0`); ~620 Jev tokens and ~320 ms per decision.
  Confidence ranged 0.76–0.98 and was correct throughout, so it carries no information about when Jev is wrong here: no threshold can be calibrated (effective n = 7 < 30), and it was not.
- Cost/benefit: the only saving available is skipping a model call on abstain-expected tasks (observed $0.006 and $0.017), while Jev is consulted on every task. No net saving is demonstrated, so **enabling is not justified yet**.
- `skill-select`: 126 decisions, ~229k Jev tokens (about 10× the workflow family per task) with no consumer. It stays shadow-only.
- Everything above is shadow data; nothing was enabled in any run.
