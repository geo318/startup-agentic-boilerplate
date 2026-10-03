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



## Read when relevant

- [Code map](context/code-map.md): ownership, entry points, existing boundaries.
- [Build plan](context/build-plan.md): open work and decisions.
- [Progress](context/progress-tracker.md): prior evidence and handoff.
- [Library docs](context/library-docs.md): relevant official docs or installed skills.

{{#if GITHUB}}
Use a branch and PR. Keep `do-not-merge` until relevant checks pass on the final revision.
Branches use `feat/short-name` (or fix/docs/refactor/perf/test/build/ci/chore/revert).
Commit and PR titles use `type(scope): short summary`, lowercase, at most 72 characters.
For independent tasks, use a separate branch and `git worktree add`; preserve other worktrees.
{{/if}}
