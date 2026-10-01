# Routine: weekly docs audit

Prompt for a scheduled agent (in Claude Code: `/schedule`, weekly). It runs unattended, changes
only documentation, and opens a pull request; it never pushes to `{{DEFAULT_BRANCH}}`.

---

Audit this repository's documentation against the code on `{{DEFAULT_BRANCH}}` and fix the drift.

1. Run `{{RUNTIME}} scripts/checks/docs-check.mjs`{{#if TYPESCRIPT}} and `{{CMD_FALLOW}}`{{/if}}. Fix every
   documentation finding; list code findings in the PR body without fixing them.
2. `context/code-map.md`: every module and app folder has a row, and every row's path exists.
3. `context/library-docs.md` and `.agents/README.md` match the installed dependencies and skills.
   For a dependency docs-check reports, run `/add-library-skill <package>`; the PR shows what it
   installed.
4. `context/build-plan.md` and `context/progress-tracker.md`: an item still open whose pull request
   merged moves to the tracker with its evidence (PR link, date).
5. Each `AGENTS.md` invariant's "enforced by" names a rule or check that still exists.
6. Prose that restates a rule now enforced by a config (Biome, oxlint, fallow, a script) becomes a
   one-line pointer to that config.

Branch `docs/weekly-audit-<yyyy-mm-dd>`, commit `docs: weekly documentation audit`, and a PR
listing each change and why. If nothing drifted, open nothing.
