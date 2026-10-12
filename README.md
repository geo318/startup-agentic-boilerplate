# Startup agentic boilerplate

[![npm](https://img.shields.io/npm/v/@geo318/agentic-boilerplate)](https://www.npmjs.com/package/@geo318/agentic-boilerplate)

On npm as [`@geo318/agentic-boilerplate`](https://www.npmjs.com/package/@geo318/agentic-boilerplate) · [release notes](CHANGELOG.md)

A shared coding-agent skill, `project-setup`, that turns a product plan into a ready-to-build repository
with project documentation and checks: agent rules, a routed
`context/` doc set, invariants, a build plan and progress tracker, workflow skills, git
conventions, CI with a merge gate — and optionally the stack's code skeleton.

## Install

```bash
npm i -D @geo318/agentic-boilerplate        # in a project: pinned as a devDependency
npx agentic-boilerplate install .           # put the skill in .agents/skills (--force to refresh)
npx agentic-boilerplate sync --dry-run      # take in template updates, then rerun without --dry-run
npm update @geo318/agentic-boilerplate      # get newer templates before syncing
```

Global skill without a project: `npx @geo318/agentic-boilerplate install --global`.

Or from a clone:

```bash
./install.sh --global --link        # available in every project; edits here apply immediately
./install.sh ~/apps/new-thing       # or only inside one project
```

The installer writes to `.agents/skills/project-setup` and adds a Claude compatibility symlink
in `.claude/skills/`. Existing installs are never overwritten; move them aside before reinstalling.
Requires Node 22+ (or Bun) and Git; the setup scripts use built-ins and need no package install.

## Use

In an empty directory or an existing repository, use your harness’s skill picker:
Codex: `$project-setup ./plan.md`. Claude Code:

```
/project-setup ./plan.md
```

or paste the plan. The skill reads the plan, asks only what it cannot infer (preset, tenancy,
whether to scaffold code, forge), shows one summary for confirmation, then renders and fills
everything, runs the checks, and hands off with the first `/architect` task.

## Lean or full setup

For a small project, choose `flags.LEAN: true` during intake. This keeps commands, invariants,
a code map, build plan, progress tracker, library docs, and applicable hooks/CI. It omits generic
architecture documents, workflow skills other than `remember`, and fallow configuration. Existing tooling stays in place.
Full setup remains the default when `LEAN` is absent or false. Switching to lean with `--sync`
does not delete existing files.

UI-enabled projects in either preset include the optional `design-taste` skill: the root
Markdown entry routes visual design plans to a short `SKILL.md`, while the detailed Taste
Standard `DESIGN.md` stays local and is only read when needed. Existing design tokens and
project-specific rules remain authoritative. Non-UI projects exclude it.

## Session continuity

Both presets include `remember`. When a new session reads `AGENTS.md`, it is instructed to
restore existing `memory.md` once, check current state, and continue your request. This relies
on the agent following repository instructions; no startup hook or background service runs.

Use `/remember save -y` (Codex: `$remember save -y`) to sync project docs and replace the handoff
without an overwrite question. Plain `save` asks before replacing existing memory. Saving is
explicit. `/remember restore` is also available manually; missing memory is skipped on startup.

## Existing projects

The same command works inside a repository that already has code. `scripts/detect.mjs`
inventories it first (package manager, apps and frameworks, scripts, linter, hooks, CI, agent
docs, layer folders) and the setup fits the project instead of reshaping it:

- its linter, git hooks, and CI stay; the checks (docs-check, conventions, fallow, oxlint
  architecture rules) are added to them;
- gates judge only new code (`fallow audit`, changed-file lint), so existing debt never blocks;
- `context/plans/adoption.md` records the debt at adoption, where the repo differs from the
  defaults, and optional moves toward them — done only when asked;
- existing `AGENTS.md`, `CLAUDE.md`, and `.claude/settings.json` are merged, never overwritten.

Later, `/project-setup` again (or `npx agentic-boilerplate sync`) in a set-up project runs **sync**: files the project never edited
are updated to the current templates, edited files are left alone, and files changed on both
sides are put in `.project-setup/sync/` to merge (tracked by `docs/archive/project-setup.lock.json`).

## What a full generated project gets

```
AGENTS.md · CLAUDE.md (@AGENTS.md) · README.md · .env.example · .gitignore
apps/<app>/AGENTS.md + CLAUDE.md          per-app dev loop and scoped rules
context/
  README.md            doc map, doc types, maintenance + size budgets
  project-overview.md  users, non-goals, stack, apps, packages, product areas
  glossary.md          agreed vocabulary
  code-map.md          "where do I change X?"
  agents-map.md        which AGENTS.md covers what
  architecture.md      router → architecture/{domain-modules,deployment,tenant-isolation,authorization,ai}.md
  code-standards.md    router → standards/{design-principles,code-organisation,react,typescript,
                       testing,delivery,database}.md
  ui-rules.md · ui-tokens.md · ui-registry.md
  library-docs.md      library → official docs or skill → project deviations
  build-plan.md        milestones (M0 foundation, M1 vertical slice…), open questions, blockers
  progress-tracker.md  dated evidence; rotates into history/
  plans/ · history/ · decisions/ (ADR 0001 initial stack)
docs/  README.md · local-setup.md · archive/product-brief.md (your plan, verbatim)
.agents/README.md + skills/{architect,review,recover,remember,imprint,add-library-skill}
                               (+ .claude/skills symlinks)
.agents/routines/docs-audit.md weekly scheduled-agent prompt: audit docs vs code, open a PR
.agents/skills/design-taste/  UI-only, opt-in visual planning skill + reference
.agents/skills-index.md        complete skill catalog, generated by scripts/skills/index.mjs
.claude/settings.json          allowlist + Stop hook (scripts/checks/agent-stop.mjs): docs-check and
                               `fallow audit` on changed files, failures sent back to the agent
.githooks/ + scripts/git/conventions.mjs     branch / commit / PR-title rules
scripts/checks/docs-check.mjs  placeholders, dead links + anchors, doc size budgets, stale catalog,
                               dependencies missing from context/library-docs.md
.github/  ci.yml · merge-gate.yml (do-not-merge) · PR template · dependabot
biome.json · tsconfig.base.json (strict)     TypeScript presets only; Biome enforces kebab-case
                                             files, no import cycles, no `export *`, no framework/ORM
                                             imports or raw `fetch` in domain modules
.fallowrc.json                               boundary zones (routes ↛ db, modules only via index.ts),
                                             dead code, duplication, complexity; `lint` also runs
                                             oxlint with the anti-slop plugin
```

Files are gated by flags (UI, Next.js, DB, auth, multi-tenant, AI, jobs, GitHub, TypeScript), so a
backend-only or non-TypeScript project gets only what applies.

## Layout of this repo

```
project-setup/
  SKILL.md                     the workflow the agent follows
  references/                  intake + answers schema, stack presets, invariants catalog,
                               doc-system rationale, skills catalog, adopt recipes
  templates/                   the output tree ({{VAR}}, {{#if FLAG}}, {{#each APPS}}, FILL markers)
  scripts/scaffold.mjs         deterministic renderer + lock/--sync (Node/Bun, no dependencies)
  scripts/detect.mjs           read-only inventory of a target repo → mode + draft answers
  snippets/ts/                 tryCatch, Guard/hasKey
install.sh
```

Structure is rendered deterministically by the script; prose that needs judgement is left as
`<!-- FILL: instruction -->` markers that the agent writes from your plan, and `docs-check.mjs`
fails until none remain.

## Found a problem?

The skill asks once whether it may report setup-tool bugs upstream (`auto`, `ask`, or `off`;
default `ask`). Important bugs get a fix PR with a regression test; moderate issues get an issue;
minor problems are mentioned in the handoff. Reports use synthetic examples and redact project data.
See [upstream reporting](project-setup/references/upstream-reporting.md).

After review comments are addressed and fixes are pushed, generated PR guidance requests
re-review with the configured agent's comment trigger (for Codex, `@codex review`), once per
head commit. This is agent guidance, not a background automation.

## Maintaining it

- A rule that proved itself in a real project → port it to `templates/` or
  `references/invariants-catalog.md`.
- Test a template change: write an answers file (schema in `references/intake.md`), render into
  a temp dir with `node project-setup/scripts/scaffold.mjs --answers a.json --target /tmp/x`,
  strip FILL markers, and run `node /tmp/x/scripts/checks/docs-check.mjs --root /tmp/x`.

Run the repository checks with `node --test 'test/*.test.mjs'`. They exercise rendering,
no-overwrite/sync behavior, installation, setup variants, documentation checks, and token audits.
These checks validate the tooling; they do not establish model quality or token savings.

For instruction-size estimates, use `node project-setup/scripts/token-audit.mjs --target <repo> --harness codex` (or `claude`/`all`). Usage telemetry is Claude-only, so a Codex or mixed inventory
never treats missing Claude calls as evidence that a skill is unused.
