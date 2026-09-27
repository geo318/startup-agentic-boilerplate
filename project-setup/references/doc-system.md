# The documentation system

Why the generated docs are shaped the way they are, so you can fill and extend them without
breaking the design. Read this before writing FILL content or adding docs the templates lack.

## Principles

1. **Load on demand.** An agent's context is the budget. `AGENTS.md` (always loaded) holds only
   invariants and a routing table; everything else is read when a task touches it. Every doc says
   *when* to read it.
2. **Three tiers.** Entry points (`AGENTS.md`, `context/README.md`) route. Routers
   (`architecture.md`, `code-standards.md`) hold one stable heading per topic, each linking a topic
   file. Topic files hold the normative detail. Stable router headings mean anchors like
   `architecture.md#tenant-isolation` survive reorganisation.
3. **One rule, one place.** Everything else links. Duplicated rules drift apart and the agent
   follows whichever copy it read last.
4. **Forward vs backward state.** `build-plan.md` is what is open; `progress-tracker.md` is dated
   evidence of what shipped. Work moves from one to the other in the same change. Initiatives
   get `plans/<name>.md`; old evidence rotates to `history/<topic>.md`.
5. **Precise status words.** local → merged → deployed → verified. "Done" without one of these is
   not a status.
6. **Scoped rules add, never override.** `apps/<app>/AGENTS.md` adds that app's dev loop and
   rules; the root invariants still hold. `CLAUDE.md` is `@AGENTS.md` everywhere so Claude Code,
   Codex, Cursor and others read one source.
7. **Skills are the library layer.** `.agents/skills/` is canonical; `.claude/skills/*` are
   symlinks into it. `.agents/README.md` indexes them; `context/library-docs.md` maps library →
   skill → project-specific deviation. Upstream skills are pinned in `skills-lock.json`.
8. **Session memory is separate.** `memory.md` holds only the latest session's handoff and is
   overwritten by `/remember save`, which must first sync the build plan and progress tracker.

## Writing FILL content

- Source every statement from the brief, the confirmed intake answers, or the code. If none of
  them says it, it is an open question in the build plan — not a guess in a doc.
- Write for an agent that has never seen the project: concrete paths, commands, and names.
- Keep tables to one line per row. A cell that needs a paragraph belongs in a topic file.
- Delete sections that do not apply rather than writing "N/A". Remove the marker line itself.
- Use the glossary's terms, exactly.
- "(planned)" is acceptable for paths that the build plan will create; say which milestone.

## Adding a doc later

| You have | Put it in | Then |
| --- | --- | --- |
| A new boundary or cross-cutting rule | `context/architecture/<topic>.md` | Router heading in `architecture.md`; routing row in `AGENTS.md` if common |
| A coding convention | `context/standards/<topic>.md` | Router heading in `code-standards.md` |
| A multi-PR initiative | `context/plans/<initiative>.md` | One-line link in `build-plan.md` |
| An operational procedure | `docs/<runbook>.md` | Row in `docs/README.md` |
| A hard-to-reverse choice | `context/decisions/NNNN-<title>.md` | Row in `decisions/README.md` |
| A UI pattern | `/imprint` → `context/ui/<component>.md` | Registry entry |
| A new app | `apps/<app>/AGENTS.md` + `CLAUDE.md` | Row in `agents-map.md` and the root repo map |

## Failure modes seen in pocos (and the countermeasure built in)

| Failure | Countermeasure |
| --- | --- |
| Build plan grew to ~690 lines and the progress tracker to ~1,700; agents stopped reading them fully | Line budgets checked by `docs-check.mjs`; `history/` rotation |
| Router headings pointed into files named for something else (deployment rules inside an authorization file) | "Name topic files for their content" maintenance rule |
| Plans said "open" for shipped work and memory said "next" for done work | `/remember save` syncs the plan docs first; delivery hygiene checklist |
| A green typecheck was reported as "works" | Verification table in `AGENTS.md`; PR template's runtime row |
| Library skills contradicted project rules | `library-docs.md` "Project notes" column; project rules win |
