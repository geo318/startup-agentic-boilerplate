---
name: add-library-skill
description: Resolve one package that docs-check reported as missing from context/library-docs.md with official docs, a useful skill, or a needs-no-notes entry. Use on that docs-check message or when the user asks to find a skill for a named library. Not for adding, upgrading, or using dependencies, or for packages already documented.
---

# Add library skill

`/add-library-skill <package>`, one package per run. Runs without asking; it stops at the first
step that settles the package, so most packages never reach a search.

1. **Still needed?** If the package is already named in `context/library-docs.md`, stop. If nothing
   imports it and no script calls its CLI, remove the dependency and stop.
2. **Worth a skill?** Only a library whose API this project's code is written against (framework,
   ORM, SDK, validation, UI kit, test runner) gets one. Types, build and lint tooling, polyfills,
   and small utilities go on the "Needs no notes" line of `context/library-docs.md`. Stop.
3. **Search,** most trusted source first, and stop at the first hit:
   - project-setup's skills catalog, if the package is listed there;
   - the library's own repository or docs (a `skills/` folder, an "agent skills" page);
   - the skills.sh registry: `npx skills find <package>`;
   - a web search for `<library> agent skill SKILL.md`.
4. **Vet** the candidate. Install it only if every check passes:
   - published by the library's authors, or widely installed and changed in the last year;
   - written for the major version in `package.json`;
   - its `SKILL.md` and scripts do not fetch URLs at load time, run network installs, or read
     credentials or env files.
   A failed check means no skill: put the official docs URL in the library-docs row and say why
   in the final report.
5. **Install:** `npx skills add <owner/repo>` (see `npx skills --help` for the flags that select
   one skill and target `.agents/skills`). It pins the source in `skills-lock.json`.{{#if CLAUDE_CODE}}
   Link it: `ln -s ../../.agents/skills/<name> .claude/skills/<name>`.{{/if}}
6. **Record** in the same change:
   - `context/library-docs.md`: a row with the package in backticks, the skill (or docs URL), and
     how this repo differs from its defaults;
   - `.agents/README.md`: a bullet under its area (installed skills only);
   - the catalog: `{{RUNTIME}} scripts/skills/index.mjs`.
7. Run `{{RUNTIME}} scripts/checks/docs-check.mjs`. Fix failures in the skill/catalog/docs
   changes and rerun; do not report completion while it fails. Then report in one line: installed `<skill>`
   from `<source>`, docs link only (why), or "needs no notes".
