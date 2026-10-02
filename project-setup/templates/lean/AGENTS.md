# {{PROJECT_NAME}}

{{ONE_LINER}}

Stack: {{STACK_SUMMARY}}. Reuse the existing architecture and installed tools.

## Commands

- Install: `{{CMD_INSTALL}}`
- Develop: `{{CMD_DEV}}`
- Lint: `{{CMD_LINT}}`
{{#if TYPESCRIPT}}
- Typecheck: `{{CMD_TYPECHECK}}`
{{/if}}
- Tests: `{{CMD_TEST_CHANGED}}`
- Docs: `{{RUNTIME}} scripts/checks/docs-check.mjs --strict`

## Rules

<!-- FILL: up to six concrete product/security invariants and the checks that enforce them. -->
- Read the affected code and its callers. Reuse an existing pattern before adding a layer.
- Validate external inputs; preserve authorization, error handling, and accessibility.
- Run relevant checks and report their actual results before handoff.
- Ask only when an unresolved decision changes implementation; existing authorization persists.
- A repeated failure needs new evidence, not another identical attempt.
- Protect acceptance checks. Changing them requires explicit maintenance authorization.

{{#if AGENTIC_RUNTIME}}
## Optional managed execution

Direct development is the default. Managed execution is off (`"enabled": false` in `.agents/policy.json`).
Use it only when the user requests it for the task; never enable it automatically or require it for ordinary edits.
`node scripts/agentic.mjs enable` opts in; `disable` returns to direct development. Keep normal project checks and CI.

For a chosen managed task, run `task preflight <id>` before execution. Routing comes from `.agents/models.json`,
not the chat model selector: `handoff` exchanges JSON packets; `delegated` invokes the configured provider.
Include an existing agreed plan in the contract's `plan` field to avoid another architect call.
R2/R3 still require `task approve <id>` and an independent reviewer context. Accept verified results explicitly.
Use `edit_and_finish` for final edits to avoid a separate finish exchange.

If scope, context or budget is insufficient, use `task revise <id> <contract.json>` with explicit authorization.
It retains the prepared candidate, baseline, history and usage; R2/R3 require fresh plan approval.
Never weaken protected tests or bypass a refused managed task. Automatic full session checks are also opt-in
(`"sessionChecks": true`); `session-check` runs them explicitly. Do not repeat identical checks without a change.
{{/if}}

## Read when relevant

- [Code map](context/code-map.md): ownership, entry points, existing boundaries.
- [Build plan](context/build-plan.md): open work and decisions.
- [Progress](context/progress-tracker.md): prior evidence and handoff.
- [Library docs](context/library-docs.md): relevant official docs or installed skills.

{{#if GITHUB}}
Use a branch and PR. Keep `do-not-merge` until relevant checks pass on the final revision.
Branches use `feat/short-name` (or fix/docs/refactor/perf/test/build/ci/chore/revert).
Commit and PR titles use `type(scope): short summary`, lowercase, at most 72 characters.
`{{RUNTIME}} scripts/git/worktrees.mjs new feat/short-name` creates a task worktree.
{{/if}}
