# Intake: from a brief to an answers file

## Contents

- [1. Extract before asking](#1-extract-before-asking)
- [2. Ask in small batches](#2-ask-in-small-batches)
- [3. Align on language](#3-align-on-language)
- [4. Choose invariants](#4-choose-invariants)
- [5. Confirm one summary](#5-confirm-one-summary)
- [answers.json schema](#answersjson-schema)

Goal: turn the user's plan into `answers.json` plus a short list of confirmed decisions, asking
only what the brief does not already answer.

## 1. Extract before asking

Read the whole brief and fill a draft of everything below. Mark each value **given** (stated),
**inferred** (your reasonable default), or **unknown**. Only unknowns and risky inferences become
questions.

| Area | Extract |
| --- | --- |
| Identity | Product name, one-line description, slug, package scope |
| Users | User types and their primary jobs; admin/back-office needs |
| Product areas | The features/modules, in the brief's priority order |
| Platforms | Web app, marketing site, public API, mobile (iOS/Android), CLI, workers |
| Data | Core entities, multi-tenancy (who owns data), sensitive data (PII, health, payments) |
| Auth | Sign-in methods, roles, invitations, SSO |
| Integrations | Payments, messaging/email, storage/uploads, AI providers, analytics, maps… |
| Background work | Schedules, queues, webhooks, long-running jobs |
| Hosting | Where each app runs; database host; region/compliance constraints |
| Stack | Anything the brief fixes (language, framework, DB, ORM, runtime, package manager) |
| Process | GitHub or other forge, CI, team size, agents used (Claude Code, Codex, Cursor) |
| Non-goals | What is explicitly out of scope |
| Milestones | Any phasing, deadlines, launch target |

## 2. Ask in small batches

Use the question tool (≤ 4 questions per round, 2–4 options each, recommended option first).
Always offer a default the user can accept. Typical first round when the brief is thin:

1. **Stack preset** — `ts-monorepo` / `next-fullstack` / `api-service` / `docs-only` (see
   [stack-presets.md](stack-presets.md)); recommend the one the platforms imply.
2. **Tenancy** — single-tenant, multi-tenant (organisations/workspaces), or multi-tenant with
   public per-tenant pages.
3. **Scaffold code now?** — docs + tooling only, or also run the stack's generators and build the
   request-path skeleton.
4. **Forge** — GitHub (CI + PR protocol + merge gate) or none yet.

For small projects, recommend `flags.LEAN: true` in the same summary: concise project-specific docs, native tooling, and no generic domain skeleton. Choose the full preset when the brief needs those architectural conventions. No additional approval round is needed.

Stop asking once every value that changes the generated files is known. Everything else is
recorded as an open question in the build plan — never invented.

## 3. Align on language

Pick 5–12 terms from the brief that could be read more than one way (roles, entities, lifecycle
states, money words). State your reading of each; ask the user to correct it. These become
`context/glossary.md`.

## 4. Choose invariants

From [invariants-catalog.md](invariants-catalog.md), pre-select the ones whose "applies when"
matches, then show the list (one line each) and let the user drop or add. Add project-specific
invariants the brief implies (e.g. "prices are integers in minor units", "no PII in logs").
Target 6–12 in `AGENTS.md`; the rest live in topic files.

## 5. Confirm one summary

Before rendering anything, show one screen:

```
Project:    <name> — <one-liner>
Preset:     <preset> (<apps>)
Stack:      <stack summary>
Flags:      UI ✓ · DB ✓ · auth ✓ · multi-tenant ✓ · AI ✗ · jobs ✓ · GitHub ✓
Invariants: <n> selected (<short names>)
Milestones: M0 Foundation · M1 <slice> · M2 …
Open:       <n> questions recorded for the build plan
Code:       docs + tooling only | + generators and skeleton
Mode:       new | adopt | upgrade (from detect.mjs)
Tooling:    adopt only — e.g. keep ESLint · husky · existing CI; checks plugged in, new code gated
```

This is the one hard gate. Proceed only on explicit confirmation.

## answers.json schema

Write it to `docs/archive/project-setup.answers.json` in the target (kept so the setup can be
re-rendered). All `vars` values are strings; all `flags` are booleans.

```json
{
  "vars": {
    "PROJECT_NAME": "Acme",
    "PROJECT_SLUG": "acme",
    "PACKAGE_SCOPE": "@acme",
    "ONE_LINER": "Acme is a scheduling and billing platform for independent clinics.",
    "SETUP_DATE": "2026-09-27",
    "DEFAULT_BRANCH": "main",
    "RUNTIME": "bun",
    "STACK_SUMMARY": "Next.js 16 App Router · Elysia on Bun · Drizzle + Postgres (Neon) · Better Auth · Zod v4 · Biome · Vitest + Playwright",
    "REQUEST_PATH": "UI → feature hook → client DAL → shared HTTP client → route → core service → repository",
    "CMD_INSTALL": "bun install",
    "CMD_INSTALL_CI": "bun install --frozen-lockfile",
    "CMD_DEV": "bun run dev",
    "CMD_LINT": "bun run lint",
    "CMD_FALLOW": "bun run fallow",
    "CMD_TYPECHECK": "bun run typecheck",
    "CMD_TEST": "bun run test",
    "CMD_TEST_CHANGED": "bunx vitest run --changed origin/main",
    "CMD_E2E": "bun run test:e2e",
    "AUTH_PACKAGE_PATTERNS": "\"better-auth\", \"@better-auth/*\""
  },
  "flags": {
    "MONOREPO": true,
    "TYPESCRIPT": true,
    "BUN": true,
    "HAS_UI": true,
    "NEXTJS": true,
    "HAS_DB": true,
    "HAS_AUTH": true,
    "MULTI_TENANT": true,
    "HAS_AI": false,
    "HAS_JOBS": false,
    "HAS_E2E": true,
    "REQUEST_PATH_SET": true,
    "GITHUB": true,
    "CLAUDE_CODE": true,
    "CLAUDE_SKILL_LINKS": true,
    "CODEX_HOOKS": false,
    "ADOPT": false,
    "OWN_LINTER": false,
    "OWN_HOOKS": false,
    "OWN_CI": false
  },
  "apps": [
    {
      "APP_DIR": "apps/web",
      "APP_NAME": "web",
      "APP_FRAMEWORK": "Next.js 16",
      "APP_PURPOSE": "Public site and authenticated dashboard.",
      "APP_DEV": "bun run dev:web",
      "APP_PORT": "3000"
    }
  ]
}
```

Notes:

- `LEAN` selects minimal project docs, keeps `remember`, `sweep`, and the lifecycle runbook/runtime, and omits generic architecture, other workflow skills, and fallow configuration. Existing files are not deleted on sync.
- `CLAUDE_CODE` enables Claude settings/lifecycle hooks; `CLAUDE_SKILL_LINKS` enables compatibility symlinks. `CODEX_HOOKS` enables project `.codex/hooks.json` only after confirming a supported local client and its native hook trust. Set flags for confirmed harnesses, not the model provider. Other clients use root instructions plus the same begin/run/finish scripts.

- `RUNTIME` runs the generated `.mjs` scripts: `bun` when `BUN`, else `node`.
- `AUTH_PACKAGE_PATTERNS` is required when `HAS_AUTH`: the auth library's packages as YAML list
  items, e.g. `"better-auth", "@better-auth/*"`. Dependabot keeps them out of grouped PRs.
- `UPSTREAM_REPORTING` is `auto`, `ask`, or `off` (default `ask`): whether the agent may report bugs in this skill upstream, see
  [upstream-reporting.md](upstream-reporting.md). It is only a record of the user's choice; no template uses it.
- `CMD_*`, `RUNTIME`, and `DEFAULT_BRANCH` may not contain `"`, `\`, or line breaks (they are
  written into JSON and YAML strings). Wrap a complex command in a package script instead.
- `NEXTJS` is true when any app uses Next.js; it adds the rendering and caching sections to
  `context/standards/react.md`. `HAS_UI` without `NEXTJS` (Expo, Vite) keeps the React rules only.
- `REQUEST_PATH_SET` is false for `docs-only` or when the layering is undecided; the request-path
  sections are then omitted rather than left vague.
- `APP_PURPOSE` is a full sentence ending with a period (it is followed by more text in the app's
  `AGENTS.md`). `APP_PORT` may be `—`.
- A single-app project at the repository root sets `MONOREPO: false` and `apps: []`; its dev loop
  goes in a section of the root `AGENTS.md` instead of a scoped file. `APP_DIR` may never be `.`,
  absolute, or contain `..` (the renderer refuses).
- `CMD_TEST_CHANGED` falls back to `CMD_TEST` when the runner has no changed-files mode.
- `ADOPT` is true for an existing codebase: renders `context/plans/adoption.md`, and leaves
  `.fallowrc.json` to be written from the real layout. `OWN_LINTER`, `OWN_HOOKS`, `OWN_CI` keep the
  project's linter, git hooks, and CI: `biome.json`, `.githooks/`, and `ci.yml` are not rendered
  and the checks are added to the existing tools ([adopt.md](adopt.md)). `detect.mjs` sets all four.
- `CMD_FALLOW` is required when `TYPESCRIPT` and not `LEAN`: the package script that runs fallow (strict on a new
  repo, `fallow audit` on adopt/upgrade — see SKILL.md step 7).
