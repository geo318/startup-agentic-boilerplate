# Delivery

Read before committing, pushing, opening a PR, or marking work complete.

## Commits and pushes

- Never push to `{{DEFAULT_BRANCH}}` by default. After local commits, summarize the commits, test
  status, and target branch, then wait for explicit confirmation before pushing. Substantial work
  goes through a branch and PR.
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

Use a worktree for any change that is not a one-liner, so branches never get mixed and parallel work (people or agents) cannot trample
each other. `{{RUNTIME}} scripts/git/worktrees.mjs` creates, lists, audits, and cleans them.

**Mapping.** One worktree = one branch = one task/PR.

- The main checkout stays on `{{DEFAULT_BRANCH}}`, clean, for reading and updating only. Never switch branches inside a worktree.
- Worktrees live *outside* the repo, at `../<repo>.worktrees/<slug>`, where `<slug>` is the branch name with `/` replaced by `-`
  (`feat/add-login` → `feat-add-login`). Claude Code's own `.claude/worktrees/` is accepted. A branch is checked out in at most one worktree.
- Create with `{{RUNTIME}} scripts/git/worktrees.mjs new <type>/<kebab-name> [--base origin/{{DEFAULT_BRANCH}}]`. It validates the branch name against
  the conventions above, fetches the base, and refuses an existing branch, an existing path, or a slug another branch already uses.

**Per worktree.** Install dependencies in each one. Copy `.env` by hand when needed and never commit it. Dev servers and databases are shared
machine resources: run them from one worktree at a time or give each its own ports and database.

**Agents.** Work in your own worktree for non-trivial changes and report its path and branch when you stop. Never modify, remove, or clean a
worktree you did not create, and never use `git worktree remove --force`, `git branch -D`, or `rm -rf` on one: ask the person.

**Cleanup.** After a PR merges, run `{{RUNTIME}} scripts/git/worktrees.mjs clean` (a dry run; add `--yes` to apply). It removes only worktrees that are
clean, fully pushed, unlocked, and whose branch is already merged into the base, using `git worktree remove` and `git branch -d` (never forced), and
never the main checkout or the directory you are in. Anything skipped is listed with the reason. A branch whose remote was deleted after a squash
merge cannot be proven merged by history, so it is listed for a person to confirm. Run `{{RUNTIME}} scripts/git/worktrees.mjs doctor` weekly: it
flags stale worktrees (no commit for 14 days and unmerged), misplaced paths, bad branch names, and missing directories (`prune` repairs metadata).
Delete remote branches through the PR's "delete branch on merge" setting, not by script.

{{#if GITHUB}}
## Pull requests

Follow [AGENTS.md → Pull requests](../../AGENTS.md#pull-requests): checks recorded in the body,
`do-not-merge` until they are verified green.

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
