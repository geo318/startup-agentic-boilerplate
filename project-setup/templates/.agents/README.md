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

See [root workflow guidance](../AGENTS.md#workflow-skills) for when to use project skills.
The [generated catalog](skills-index.md) lists their descriptions and entrypoints.

## Libraries and domains

<!-- FILL: one bullet per installed library/domain skill, grouped by area (Tooling, Web, API & data, Mobile, AI, Payments & jobs): "`name` (upstream `owner/repo` or "project"): when to load it". -->

## Pruned on purpose

<!-- FILL: skills deliberately not installed because they conflict with the stack (e.g. "Prisma skills: project uses Drizzle"). Write "None." if nothing was pruned. -->
