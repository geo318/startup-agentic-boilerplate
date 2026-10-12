# Changelog

Update a project with `npm update @geo318/agentic-boilerplate`, then
`npx agentic-boilerplate sync --dry-run` and rerun without `--dry-run`.

## 0.1.3 — 2026-10-12

- `package.json` `repository` uses the object form npm expects; no functional changes.

## 0.1.2 — 2026-10-12

- `install` in a project that has the package as a devDependency links `.agents/skills/project-setup`
  to `node_modules` instead of copying, so `npm update` also updates the skill. Rerun
  `npx agentic-boilerplate install . --force` to replace an earlier copy.
- The skills index no longer crashes on a skill link that dangles before `npm install`, and
  setup keeps a linked skill instead of offering to remove it.
- README rewritten around why to use the setup; the publish workflow only releases tags on `main`.

## 0.1.1 — 2026-10-12

- Package renamed from `@geo318/project-setup` (deprecated) to `@geo318/agentic-boilerplate`;
  the command is now `agentic-boilerplate`.
- Install as a devDependency so each project pins the template version it syncs from.
- Release notes ship in the package as `CHANGELOG.md`.

## 0.1.0 — 2026-10-12

First npm release of the `project-setup` skill.

- `install <dir>|--global [--link] [--force]` copies the skill into `.agents/skills/project-setup`
  with a `.claude/skills` link; `sync [dir] [--dry-run]` takes in template updates.
- Sets up new or existing repositories from a plan: `AGENTS.md`, routed `context/` docs,
  invariants, build plan and progress tracker, workflow skills, git conventions, CI merge gate,
  optional code skeleton; lean and full presets.
- Adopting existing repos keeps their linter, hooks and CI, and gates only new code.
- Deterministic checks shipped into projects: docs-check (placeholders, links, budgets, skill
  catalog, library docs), conventions, fallow, oxlint architecture rules, token audit.
- Sync updates files the project never edited, leaves local edits alone, and stages files
  changed on both sides in `.project-setup/sync/` for merging.
- UI planning routes to the Taste Standard on demand; worktrees live under `.worktrees/`.
