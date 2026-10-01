---
name: project-setup
description: Turn a product plan into a ready-to-build project — agent rules (AGENTS.md/CLAUDE.md), a context/ documentation system (overview, code map, architecture, code standards, invariants, glossary, build plan, progress tracker, decisions), workflow skills (architect, review, recover, remember, imprint, add-library-skill), deterministic checks (Biome, oxlint, fallow boundaries/dead code, docs-check, a Claude Code Stop hook), git conventions with hooks, CI with a merge gate, and optionally the stack's code skeleton. Use when starting a new project from a brief/plan/PRD, bootstrapping or scaffolding a repo for agentic development, or retrofitting this documentation system onto an existing codebase.
---

# Project setup

Builds an agentic project foundation in the current directory from the user's plan.
The output is a repository where any coding agent knows the product, the rules, where things go,
what is next, and how to verify its work.

Paths below are relative to this skill's directory unless they start with the target repo.

## Ground rules

- **Never invent product facts.** Everything written comes from the brief, the user's answers, or
  the code. Unknowns become open questions in `context/build-plan.md`.
- **Never overwrite existing files** without showing what is there and getting a yes. The renderer
  skips existing files; you merge them by hand.
- **One confirmation gate** before writing anything (step 3). Ask only questions whose answers change
  the output.
- Read [references/doc-system.md](references/doc-system.md) before writing any FILL content.

## Workflow

### 1. Preflight

- Target = the current working directory unless the user names another.
- Run `node <skill-dir>/scripts/detect.mjs --target <target>` and read its JSON before anything
  else. It gives the `mode`, a draft answers file, existing tooling, layer folders, conflicts, and
  unknowns:
  - **new** (empty, or only `.git`/`.claude`): the full workflow below.
  - **adopt** (code, no `AGENTS.md`) or **upgrade** (has `AGENTS.md`/`context/`): the system fits
    the project — follow [references/adopt.md](references/adopt.md) alongside the steps below.
    Read the README and any agent docs too; the code is the source of truth.
  - Every mode: `tokenTools` in the JSON says whether rtk, headroom, and ponytail are installed.
  - **sync** (has `docs/archive/project-setup.answers.json`): go to [Sync](#sync).
- Get the brief: a file path, pasted text, or a URL the user gives. If there is none, ask for it
  (a few paragraphs are enough) — in adopt/upgrade mode the README and the user's answers stand
  in for it. Keep the original text; it is archived verbatim.

### 2. Intake

Follow [references/intake.md](references/intake.md): extract, ask gaps in small batches, choose a
preset from [references/stack-presets.md](references/stack-presets.md), align the glossary, and
select invariants from [references/invariants-catalog.md](references/invariants-catalog.md).
In adopt/upgrade mode, start from detect's `draftAnswers`: ask no stack questions; confirm the
detected apps and commands in one batch, then ask only its `unknowns` and `conflicts`. The
`OWN_LINTER`/`OWN_HOOKS`/`OWN_CI` flags keep the project's tools; `ADOPT` renders the adoption
plan and leaves `.fallowrc.json` to be written from the real layout.

### 3. Confirm

Show the one-screen summary from intake.md. Do not write files until the user confirms.
Add one line per missing `tokenTools` entry with its install command from
[references/token-tools.md](references/token-tools.md); the user may accept or skip each.

### 4. Scaffold code (only if the user chose it)

Run the preset's generators and skeleton steps from stack-presets.md **before** rendering docs.
Use `snippets/ts/` for `try-catch.ts` and `guards.ts`. Build the domain skeleton (shared kernel,
unit of work, composition root) described in the preset. Install dependencies and confirm the dev
server starts. Architecture rules are rendered as config in step 5 (`.fallowrc.json` zones,
`biome.json` overrides) from the preset's paths — adjust them there if the skeleton differs.

### 5. Render

Write the answers to `<target>/docs/archive/project-setup.answers.json`, then:

```bash
node <skill-dir>/scripts/scaffold.mjs --answers <target>/docs/archive/project-setup.answers.json --target <target> --dry-run
node <skill-dir>/scripts/scaffold.mjs --answers <target>/docs/archive/project-setup.answers.json --target <target>
```

Review the dry-run list first. If any variable or block is unresolved, or an answer contains a
refused character, the renderer writes nothing — fix the answers file and rerun. For each
**skipped** file, merge the template's content into the existing file by hand.

### 6. Fill

Work through every `<!-- FILL: … -->` marker (`grep -rn "FILL:" <target> --include=*.md`, plus
`.agents/skills/*/SKILL.md`). Each marker's text is the instruction; replace the whole marker with
the content. Order: `docs/archive/product-brief.md` (paste the brief verbatim) →
`context/project-overview.md` → `glossary.md` → `AGENTS.md` invariants → `architecture.md` and its
topics (including `architecture/domain-modules.md`, whose modules come from the product areas) →
`code-map.md` (one row per module) → `code-standards.md` and `standards/code-organisation.md` →
app `AGENTS.md` files → `build-plan.md` → decisions → the rest. Keep `AGENTS.md` under 200 lines.

### 7. Wire tooling

- `package.json` (JS/TS repos): add these scripts, and make `lint`/`typecheck`/`test` match
  the commands in the answers. Run the install so the hooks activate.

  ```json
  "prepare": "<runtime> scripts/git/conventions.mjs install-hooks",
  "lint": "biome check . && oxlint",
  "fallow": "fallow --quiet",
  "docs:check": "<runtime> scripts/checks/docs-check.mjs",
  "skills:index": "<runtime> scripts/skills/index.mjs",
  "git:check-current-branch": "<runtime> scripts/git/conventions.mjs current"
  ```

  `fallow` is strict on a **new** repo (any finding fails). On **adopt/upgrade**, make it
  `"fallow audit --quiet"`: only findings the branch introduces fail, so existing debt does not
  block work and no baseline file is needed. `CMD_FALLOW` in the answers runs this script.

  **Adopt/upgrade:** follow [references/adopt.md](references/adopt.md) instead of the defaults
  above wherever an `OWN_*` flag is set — `lint:changed` as `CMD_LINT`, architecture rules in
  `oxlint.config.ts`, our checks added to the project's hooks and CI, no `prepare` script, a
  hand-written `.fallowrc.json`, and `context/plans/adoption.md` filled with the debt snapshot.

  `docs:check` also verifies the skill catalog and that every dependency is named in
  `context/library-docs.md`, so CI and the pre-push hook fail when a skill or library is added
  without its docs. Non-JS repos: run `node scripts/git/conventions.mjs install-hooks` once and
  document it in `docs/local-setup.md`.
- TypeScript repos: install `@biomejs/biome`, `fallow`, and `oxlint` as dev dependencies at their
  current versions (`npm view <pkg> version`; never versions from memory). Then install the
  `install-anti-slop` skill (`dmmulroy/anti-slop`) and follow it: it vendors the plugin into
  `tools/oxlint/anti-slop/` (already excluded in `biome.json` and `.fallowrc.json`), adds
  `@oxlint/plugins`, and writes `oxlint.config.ts`. Run `lint` and `fallow` once on the skeleton
  and fix what they report — a fresh skeleton must be clean.
- Install library skills for the confirmed stack per
  [references/skills-catalog.md](references/skills-catalog.md); fill `.agents/README.md` and
  `context/library-docs.md` from what was actually installed, then regenerate the catalog with
  `<runtime> scripts/skills/index.mjs`. A dependency with no catalog entry goes through the
  generated `/add-library-skill` workflow (needs a skill? → search skills.sh and the web → vet →
  install).
- Token tools the user accepted: give them the install commands (token-tools.md); you cannot run
  `/plugin` commands. Write the "Token tools" section of `AGENTS.md` for the tools present, which
  is how subagents learn of them.
- `git init -b <default-branch>` if the target is not a repository.
- GitHub (if chosen): tell the user to create the `do-not-merge` label and make `Merge gate` and
  `CI` required checks — do not do it for them unless asked.

### 8. Verify

Run, read, and fix until clean:

```bash
node <target>/scripts/checks/docs-check.mjs --root <target>
node <target>/scripts/git/conventions.mjs title "feat(setup): scaffold project foundation"
```

Plus the project's lint/typecheck/test when code exists, and a YAML parse of the rendered
workflows (`bunx yaml-lint` or `python3 -c "import yaml,sys;yaml.safe_load(open(sys.argv[1]))" <file>`).

### 9. Hand off

- Fill the progress tracker's setup entry with what was created and which checks passed.
- Offer (do not do unasked) a first commit on a branch such as `chore/project-setup`.
- GitHub projects: offer to schedule `.agents/routines/docs-audit.md` as a weekly cloud agent
  (`/schedule`). It audits docs against code and opens a PR; do not create it unasked.
- Run the post-setup token audit from [references/token-tools.md](references/token-tools.md)
  (`scripts/token-audit.mjs`) and add its suggestions (max five) to the report; change nothing.
- Report in a short list: what was generated, open questions recorded, and the next step —
  usually `/architect` on the first M1 task in the build plan.
- If this skill was installed inside the project (`.claude/skills/project-setup`), offer to
  remove it; it is not needed after setup.

## Sync

For a project set up by this skill, to take in template improvements made since. Every render
records what it wrote in `docs/archive/project-setup.lock.json`.

```bash
node <skill-dir>/scripts/scaffold.mjs --answers <target>/docs/archive/project-setup.answers.json --target <target> --sync --dry-run
node <skill-dir>/scripts/scaffold.mjs --answers <target>/docs/archive/project-setup.answers.json --target <target> --sync
```

- Missing files are created; files the project never edited are updated; files only the project
  changed are left alone.
- Files changed on both sides are listed under **merge**, with the new render in
  `.project-setup/sync/<path>`. Diff each against the project's file, keep the project's content
  and take the template's improvements, then delete `.project-setup/`.
- An unresolved variable means a template gained one: add it to the answers file (check
  [intake.md](references/intake.md) for its meaning) and rerun.
- Fill any FILL markers in newly created files, then run the step 8 checks.

Never pass `--force` without the user's yes; `--sync` never overwrites an edited file.

## Files in this skill

| Path | What |
| --- | --- |
| `templates/` | The output tree. `manifest.json` gates files on flags and renames dotfiles. |
| `scripts/scaffold.mjs` | Renderer: `{{VAR}}`, `{{#if}}/{{else}}/{{/if}}`, `{{#unless}}`, `{{#each APPS}}`, `__APP_DIR__` paths; lock file and `--sync`. |
| `templates/scripts/checks/docs-check.mjs` | Ships into the project: placeholders, FILL markers, links, anchors, line budgets, stale skill catalog, dependencies missing from library-docs. |
| `templates/scripts/skills/index.mjs` | Ships into the project: generates `.agents/skills-index.md` from each `SKILL.md`; `--check` for CI. |
| `templates/scripts/checks/agent-stop.mjs` | Ships into the project: Claude Code Stop hook — docs-check + `fallow audit` on changed files, failures returned to the agent. |
| `scripts/detect.mjs` | Read-only inventory of a target: mode, draft answers, tooling, layers, conflicts. |
| `scripts/token-audit.mjs` | Read-only audit of always-loaded context (instructions, skills, MCP servers, plugins) against usage in recent transcripts. |
| `snippets/ts/` | Code copied by hand during step 4. |
| `references/` | Intake, presets, invariants, doc-system rationale, skills catalog. |
