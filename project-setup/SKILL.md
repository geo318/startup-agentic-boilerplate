---
name: project-setup
description: Turn a product plan into a ready-to-build project — agent rules (AGENTS.md/CLAUDE.md), a context/ documentation system (overview, code map, architecture, code standards, invariants, glossary, build plan, progress tracker, decisions), workflow skills (architect, review, recover, remember, imprint), git conventions with hooks, CI with a merge gate, and optionally the stack's code skeleton. Use when starting a new project from a brief/plan/PRD, bootstrapping or scaffolding a repo for agentic development, or retrofitting this documentation system onto an existing codebase.
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
- Classify it: **new** (empty, or only `.git`/`.claude`), **adopt** (has code but no `AGENTS.md`),
  or **upgrade** (already has `AGENTS.md`/`context/`). Adopt/upgrade: read the existing README,
  manifests (`package.json`, lockfiles, `pyproject.toml`…), top-level tree, and any agent docs
  first — the code is the source of truth for stack and structure.
- Get the brief: a file path, pasted text, or a URL the user gives. If there is none, ask for it
  (a few paragraphs are enough). Keep the original text; it is archived verbatim.

### 2. Intake

Follow [references/intake.md](references/intake.md): extract, ask gaps in small batches, choose a
preset from [references/stack-presets.md](references/stack-presets.md), align the glossary, and
select invariants from [references/invariants-catalog.md](references/invariants-catalog.md).
In adopt/upgrade mode, derive the preset, commands, and apps from the code instead of asking.

### 3. Confirm

Show the one-screen summary from intake.md. Do not write files until the user confirms.

### 4. Scaffold code (only if the user chose it)

Run the preset's generators and skeleton steps from stack-presets.md **before** rendering docs.
Use `snippets/ts/` for `try-catch.ts`, `guards.ts`, and `architecture-contract.unit.test.ts`
(edit its `RULES`, scope, and root depth — it contains a `FIXME(setup)` to resolve). Install
dependencies and confirm the dev server starts.

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
topics → `code-map.md` → `code-standards.md` → app `AGENTS.md` files → `build-plan.md` →
decisions → the rest. Keep `AGENTS.md` under 200 lines.

### 7. Wire tooling

- `package.json` (JS/TS repos): add these scripts, and make `lint`/`typecheck`/`test` match
  the commands in the answers. Run the install so the hooks activate.

  ```json
  "prepare": "<runtime> scripts/git/conventions.mjs install-hooks",
  "docs:check": "<runtime> scripts/checks/docs-check.mjs",
  "skills:index": "<runtime> scripts/skills/index.mjs",
  "git:check-current-branch": "<runtime> scripts/git/conventions.mjs current"
  ```

  `docs:check` also verifies the generated skill catalog, so CI and the pre-push hook fail when
  a skill is added without regenerating it. Non-JS repos: run
  `node scripts/git/conventions.mjs install-hooks` once and document it in `docs/local-setup.md`.
- Install library skills for the confirmed stack per
  [references/skills-catalog.md](references/skills-catalog.md); fill `.agents/README.md` and
  `context/library-docs.md` from what was actually installed, then regenerate the catalog with
  `<runtime> scripts/skills/index.mjs`.
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
- Report in a short list: what was generated, open questions recorded, and the next step —
  usually `/architect` on the first M1 task in the build plan.
- If this skill was installed inside the project (`.claude/skills/project-setup`), offer to
  remove it; it is not needed after setup.

## Re-running

Rerunning on a set-up repo renders only missing files (e.g. after enabling a flag). To regenerate
a file, move the old one aside, rerender, and merge. Never pass `--force` without the user's yes.

## Files in this skill

| Path | What |
| --- | --- |
| `templates/` | The output tree. `manifest.json` gates files on flags and renames dotfiles. |
| `scripts/scaffold.mjs` | Renderer: `{{VAR}}`, `{{#if}}/{{else}}/{{/if}}`, `{{#unless}}`, `{{#each APPS}}`, `__APP_DIR__` paths. |
| `templates/scripts/checks/docs-check.mjs` | Ships into the project: placeholders, FILL markers, links, anchors, line budgets, stale skill catalog. |
| `templates/scripts/skills/index.mjs` | Ships into the project: generates `.agents/skills-index.md` from each `SKILL.md`; `--check` for CI. |
| `snippets/ts/` | Code copied by hand during step 4. |
| `references/` | Intake, presets, invariants, doc-system rationale, skills catalog. |
