# Delivery

Read before committing, pushing, opening a PR, or marking work complete.

## Commits and pushes

- Never push to `{{DEFAULT_BRANCH}}` by default. After local commits, summarize the commits, test
  status, and target branch. Push when authorized in the current conversation; otherwise ask once
  after the changes are verified. Substantial work goes through a branch and PR.
- Keep commits atomic: one independently reviewable concern with its tests. Split contracts,
  transport wiring, UI behavior, and background work when they can be reviewed separately.
  Documentation travels with the behavior it documents.
- Never bypass hooks with `--no-verify`. Fix the name or the history instead.

## Git conventions

Enforced locally by {{#if OWN_HOOKS}}the project's existing git hooks{{else}}`.githooks/` (installed by `{{RUNTIME}} scripts/git/conventions.mjs install-hooks`){{/if}}{{#if GITHUB}} and
in CI on every PR{{/if}}.

- **Branches:** `<type>/<kebab-case-description>`. Types: `feat`, `fix`, `docs`, `refactor`,
  `perf`, `test`, `build`, `ci`, `chore`, `revert`, `hotfix`, `release`. `dependabot/*` is
  reserved. No usernames, agent names, or generic names like `changes`.
- **Commit subjects and PR titles:** Conventional Commits — `<type>(optional-scope): summary`.
  Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
  Summary starts lowercase, no trailing period, whole subject ≤ 72 characters. `!` before the
  colon marks a breaking change, explained in the body.
- Check before pushing: `{{RUNTIME}} scripts/git/conventions.mjs current`.

## Worktrees

For independent tasks or parallel work, use one branch and worktree per task/PR:

```bash
git fetch origin
git worktree add .worktrees/<task> -b feat/<task> origin/{{DEFAULT_BRANCH}}
```

Keep worktrees inside the repo under `.worktrees/` (gitignored). Never create them outside the repo dir.

Install dependencies per worktree; keep secrets out of Git. Use separate ports when running
multiple dev servers. Do not modify or remove another person's worktree. After merge, check
for uncommitted and unpushed work before using `git worktree remove <path>` and `git branch -d <branch>`.
Never force cleanup to bypass those checks.

Occasional cleanup: at the start of a task, or when `git worktree list` shows more than a few, run
`git worktree prune` and remove worktrees whose branch is merged or deleted upstream (same checks as
above). Leave unmerged or dirty ones alone and mention them.

{{#if GITHUB}}
## Pull requests

Stacking one PR onto another branch: use `gh stack` (`init`, `add`, `submit`, `sync`; see
`gh stack --help`), not hand-managed base branches or manual retargeting. It is a GitHub CLI
extension (CLI 2.90+): `gh extension install github/gh-stack`. If it is not installed, ask before
installing it; without it, open the dependent PR against its parent branch.

1. **Before opening:** run the [verification checks](../../AGENTS.md#verification-before-handoff) and list each result in the PR body,
   including anything skipped and why ([PR template](../../.github/pull_request_template.md)).
2. **Opening:** once the PR is open, add `do-not-merge` once if a check was not run, failed, or its
   output was not read. Do not re-add it on later pushes while it is still set; re-add it only if it
   was already removed and a later push adds code you have not verified. The **Merge gate**
   workflow fails while it is set.
3. **Review fixes:** follow the re-review procedure below after pushing fixes.
4. **Merging:** remove `do-not-merge` only after every relevant check passed on the final head
   commit. If asked to merge while it is set, say which checks are missing instead.

After pushing review fixes, confirm the PR head contains the fixes, then request another review
with the configured agent's supported PR-comment trigger. For Codex, post `@codex review`;
for another integration, use its documented trigger. Check existing comments and review activity
to avoid a duplicate request or an already-running review of that head. If no review integration
or trigger is known, report that a manual review request is needed. A request is not a completed
review: report whether re-review was requested, is pending, or completed.

Make the request concrete: name the last completed review's commit and the new head SHA,
link their comparison (`<reviewed-sha>..<head-sha>`), list the commits in that range, and briefly
summarize the fixes and checks. Ask the reviewer to verify the prior findings and inspect the
new changes for regressions, reading surrounding code as needed. Use commit SHAs rather than
"last commit" or "last three commits", which become ambiguous after another push. Confirm the
reviewed commit is an ancestor of the head; if it is unknown or history was rewritten, request
the full PR diff and state that scope instead of guessing a range.

Example comment (replace the trigger for the configured integration):

```text
@codex review
Please review <reviewed-sha>..<head-sha> (<comparison URL>).
Commits: <SHA — summary for each commit>.
Focus: verify the previous findings are fixed and check the new changes for regressions.
Validation: <checks and results; anything not verified>.
```

If a review is already running, clarify its scope by editing the existing request instead of
posting a duplicate trigger. An edit does not guarantee the active run picks up a newer head;
check the reviewed SHA when it finishes and request the remaining range if needed.

{{/if}}
## Documentation hygiene

When work lands or a milestone completes, update the docs in the same change set:

- `context/progress-tracker.md` — a dated entry: what shipped, the evidence, and what remains
  unverified. Use the status words local / merged / deployed / verified precisely.
- `context/build-plan.md` — remove or rewrite what is no longer open; add new gaps and blockers.
- `context/architecture.md`, `context/code-standards.md`, `context/library-docs.md` — when the
  change alters a boundary, a rule, or required library guidance. Update any app `AGENTS.md` that
  summarizes the changed rule.
{{#if HAS_UI}}
- `context/ui-registry.md` — through `/imprint` after any new UI component.
{{/if}}
- `.agents/skills-index.md` — regenerate with `{{RUNTIME}} scripts/skills/index.mjs` whenever a
  skill is added, removed, or its description changes. Never edit it by hand; docs-check fails
  while it is stale.

Before calling a feature done, scan the touched area for stale "TODO", "mock", "placeholder", or
outdated blocker notes; fix them or say why they remain true. Then run
`{{RUNTIME}} scripts/checks/docs-check.mjs`.
