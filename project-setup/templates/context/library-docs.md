# Library docs

Before writing code against a third-party library, load its skill. Project rules in `AGENTS.md` and
`context/` override a skill's generic examples. Full skill index: [.agents/README.md](../.agents/README.md).

| Library / area | Skill | Project notes |
| --- | --- | --- |
<!-- FILL: one row per library in the confirmed stack that has an installed skill (see project-setup's skills catalog); the Library column names each package in backticks, e.g. "Zod (`zod`)". Project notes = the one or two things this repo does differently from the library's defaults, or "—". Libraries without a skill get a link to their official docs in the Skill column. -->

Needs no notes: <!-- FILL: every remaining dependency in backticks, comma-separated — tooling and libraries used exactly as documented (e.g. `typescript`, `@biomejs/biome`, `oxlint`, `@oxlint/plugins`, `fallow`). -->

## Maintenance

`docs-check` fails when a dependency in any `package.json` is not named here in backticks. A new
library gets a row through `/add-library-skill <package>`, or joins the line above when it needs
no notes. When a skill's advice conflicts with a project rule, record it in Project notes.
