# Project agent skills

Canonical skill directory for {{PROJECT_NAME}}. {{#if CLAUDE_CODE}}`.claude/skills/<name>` entries are symlinks into
here, so Claude Code and other agents read the same files. {{/if}}Upstream skills are recorded in
`skills-lock.json` by the skills CLI; project-adapted copies say so in their own header.

Root rules in [AGENTS.md](../AGENTS.md) and the [context entry points](../context/README.md) take
precedence over generic skill guidance.

## Load only what the task needs

Pick the skill from this index, read its `SKILL.md`, then follow only the references the current
operation needs. Never load every skill in a category or every reference a skill links.

For skills outside these common workflows, use the [complete skill catalog](skills-index.md).

## Workflow

- `architect`: before a non-trivial feature — align terms, resolve decisions, confirmed plan.
- `review`: after a feature — verify against plan, architecture, and standards; report only.
- `recover`: after one failed correction — diagnose the failure type before acting.
- `remember`: `save` / `restore` session state in `memory.md`, keeping plan docs in sync.
- `add-library-skill`: when docs-check names a package missing from library docs — skill, docs link, or "needs no notes".
{{#if HAS_UI}}
- `imprint`: after a new UI component — record its patterns in the UI registry.
{{/if}}

## Libraries and domains

<!-- FILL: one bullet per installed library/domain skill, grouped by area (Tooling, Web, API & data, Mobile, AI, Payments & jobs): "`name` (upstream `owner/repo` or "project"): when to load it". -->

## Pruned on purpose

<!-- FILL: skills deliberately not installed because they conflict with the stack (e.g. "Prisma skills: project uses Drizzle"). Write "None." if nothing was pruned. -->
{{#if AGENTIC_RUNTIME}}

## Managed runtime (optional)

- `stats`: how the managed workflow has been used here (measured spend and outcomes, no savings claims).

`node scripts/agentic.mjs doctor` checks the pinned runtime. Gates and protected paths live in
`policy.json`; model profiles in `models.json` (a cheap-worker/strong-worker default is generated; `models.example.json` shows other kinds; never put keys in either). Each profile must pass `agentic qualify <profile>` once before it can run (this spends a little); `architect`/`reviewer` need `qualify <profile> --owner-declare architecture|review`.
Plan approval, acceptance, and the Docker yes/no are given by the person at their own terminal.
Changes to `.agents/`, CI, hooks, lockfiles, and test configs are protected: the runtime refuses them
inside a task, so make them as ordinary reviewed changes.
{{/if}}
