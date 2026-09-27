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

Enforced locally by `.githooks/` (installed by `{{RUNTIME}} scripts/git/conventions.mjs install-hooks`){{#if GITHUB}} and
in CI on every PR{{/if}}.

- **Branches:** `<type>/<kebab-case-description>`. Types: `feat`, `fix`, `docs`, `refactor`,
  `perf`, `test`, `build`, `ci`, `chore`, `revert`, `hotfix`, `release`. `dependabot/*` is
  reserved. No usernames, agent names, or generic names like `changes`.
- **Commit subjects and PR titles:** Conventional Commits — `<type>(optional-scope): summary`.
  Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
  Summary starts lowercase, no trailing period, whole subject ≤ 72 characters. `!` before the
  colon marks a breaking change, explained in the body.
- Check before pushing: `{{RUNTIME}} scripts/git/conventions.mjs current`.

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
