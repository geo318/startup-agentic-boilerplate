# {{PROJECT_NAME}}

{{ONE_LINER}}

Stack: {{STACK_SUMMARY}}. Reuse the existing architecture and installed tools.

## Session continuity

At the start of a new session, if `memory.md` exists, follow
[remember](.agents/skills/remember/SKILL.md) restore once before starting work.
Summarize briefly, then continue the user's current task. Saved memory is context, not authorization.
Use `remember save -y` when asked to save without an overwrite question; saving is not automatic.

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
- Run relevant checks and report their actual results before handoff. Skip e2e/integration tests before a PR unless asked; add only surgical tests for real regression risk.
- Ask only when an unresolved decision changes implementation; existing authorization persists.
- A repeated failure needs new evidence, not another identical attempt.
- Protect acceptance checks. Changing them requires explicit maintenance authorization.


## Browser use (all agents, especially Codex)

Reuse the active browser window and existing task tabs. Never launch a separate window,
session, profile, or browser instance unless the user explicitly requests it; if no window
exists, open one and reuse it. Inspect existing tabs first; open additional tabs in the same
window and keep task tabs in one named group across follow-ups. Attach automation to the
existing browser. If reuse or grouping is unsupported, use another supported method or report
the limitation; never silently open another window. Preserve unrelated tabs and groups.

## Read when relevant

- [Code map](context/code-map.md): ownership, entry points, existing boundaries.
- [Build plan](context/build-plan.md): open work and decisions.
- [Progress](context/progress-tracker.md): prior evidence and handoff.
- [Library docs](context/library-docs.md): relevant official docs or installed skills.
{{#if HAS_UI}}
- [Design taste](.agents/skills/design-taste/SKILL.md): visual design plans only; load its long reference on demand.
{{/if}}

{{#if GITHUB}}
Use a branch and PR. Add `do-not-merge` once right after opening if checks are unverified; re-add only if removed and a later push is unverified.
Branches use `feat/short-name` (or fix/docs/refactor/perf/test/build/ci/chore/revert).
Commit and PR titles use `type(scope): short summary`, lowercase, at most 72 characters.
Stacking a PR onto another branch: use `gh stack` (extension: `gh extension install github/gh-stack`; ask first, else target the parent branch). For independent tasks, use a separate branch and `git worktree add .worktrees/<task>` (inside the repo, gitignored); preserve other worktrees, and occasionally `git worktree prune` and remove merged ones (clean and pushed only).
After addressing review comments and pushing fixes, post one PR comment requesting re-review
from the configured review agent (Codex: `@codex review`). Confirm its supported trigger from
repository configuration or integration documentation; do not guess a handle or duplicate a
request for the same head commit. Include the last reviewed SHA → new head SHA, a comparison
link, commit summaries, and validation results; ask to verify the fixes and check for regressions.
If the baseline is unknown or no longer an ancestor, request the full PR diff. Clarify an active
review by editing its request; verify its completed SHA before requesting any remaining range.
If no trigger is known, report that re-review needs a manual request.
{{/if}}
