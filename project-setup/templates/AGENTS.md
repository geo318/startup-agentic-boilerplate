# {{PROJECT_NAME}}

{{ONE_LINER}}
<!-- FILL: 1–2 sentences: who uses it, its core job, the repo shape. No marketing. -->

## Stack (locked; do not switch)

{{STACK_SUMMARY}}
<!-- FILL: lock sentence only for choices the brief treats as fixed. Delete if none. -->

## Repo map

| Path | Purpose |
| --- | --- |
{{#each APPS}}
| `{{APP_DIR}}` | {{APP_PURPOSE}} → [`{{APP_DIR}}/AGENTS.md`]({{APP_DIR}}/AGENTS.md) |
{{/each}}
<!-- FILL: one row per shared package / top-level folder; purpose under ~10 words. -->
| `context/` | Project docs: rules, architecture, plans, evidence (routing below) |
| `docs/` | Operational runbooks and design records |

{{#if MONOREPO}}
Working in an app? Read its `AGENTS.md` first: dev loop, verification, scoped rules
([AGENTS.md map](context/agents-map.md)). Unsure where a change belongs? See the [code map](context/code-map.md).
{{else}}
Unsure where a change belongs? See the [code map](context/code-map.md).

## Dev loop

1. Start with `{{CMD_DEV}}`. Reuse a running dev server; never start a second one.
2. <!-- FILL: framework-specific step (Next.js: use the `next-dev-loop` skill; else read the version-matched docs in node_modules). -->
3. After editing, verify in the running app — <!-- FILL: how (browser via Playwright/devtools MCP, curl against the local API) -->. A typecheck is not verification.
{{/if}}

## Invariants (never violate)

{{#if REQUEST_PATH_SET}}
- Request path: `{{REQUEST_PATH}}`. Each layer talks only to its neighbour; details in
  [architecture](context/architecture.md#canonical-request-path).
{{/if}}
<!-- FILL: 6–12 bullets from the invariants catalog plus brief-specific ones: rule in one sentence, then where it is enforced. Data/security first, style last. -->
- Unfamiliar library API: read the [library docs](context/library-docs.md) or installed skill. Project rules override generic examples.
- Same problem after one corrective attempt → stop and run `/recover`.
- Questions: ask in plain text and end the turn — never `AskUserQuestion` or plan-approval dialogs
  (they block the session). Ask only when the answer changes the implementation and docs and code
  don't settle it; recommended option first. Small choices: say `Assumed: X (alternative: Y)` and
  continue. Irreversible actions (deleting data, force-push, publishing, spending) need an explicit yes.

## Verification before handoff

Run every check relevant to the diff and read its output; a passing typecheck is not verification.
No e2e or integration runs before opening a PR unless asked. Add only surgical tests for real
regression risk ([testing](context/standards/testing.md)).

| Check | Command | Needed when |
| --- | --- | --- |
| Lint + format | `{{CMD_LINT}}` | always |
{{#if TYPESCRIPT}}
| Typecheck | `{{CMD_TYPECHECK}}` | any TS change |
{{/if}}
| Affected tests | `{{CMD_TEST_CHANGED}}` | any code change |
{{#if HAS_E2E}}
| End-to-end | `{{CMD_E2E}}` | only when explicitly asked |
{{/if}}
{{#if TYPESCRIPT}}
| Architecture, dead code, duplication, complexity | `{{CMD_FALLOW}}` | any code change |
{{/if}}
| Docs | `{{RUNTIME}} scripts/checks/docs-check.mjs` | any `.md` or `package.json` change |
{{#if HAS_UI}}
| Runtime | drive the running app (see the app's `AGENTS.md`) | any UI or request-path change |
{{/if}}

{{#if GITHUB}}

## Pull requests

Follow [delivery → Pull requests](context/standards/delivery.md#pull-requests) for
verification, the `do-not-merge` gate, and re-review after fixes.

{{/if}}
## What to read, and when

Read only the rows your task touches. [context/README.md](context/README.md) maps every doc.

| Task | Read |
| --- | --- |
| Any implementation | [architecture](context/architecture.md) + [code standards](context/code-standards.md) (routers: follow only matching links) |
| New module, use case, entity, port, or repository | [domain modules](context/architecture/domain-modules.md) |
| New file or folder; naming; where code goes | [code organisation](context/standards/code-organisation.md) |
| Product | [overview](context/project-overview.md), [glossary](context/glossary.md) |
{{#if HAS_UI}}
| UI work (components, styling, forms) | [UI rules](context/ui-rules.md), [UI tokens](context/ui-tokens.md) |
| Visual design planning, redesign, or Stitch briefs | [design-taste](.agents/skills/design-taste/SKILL.md) (detailed reference only on demand) |
| React state, data fetching, caching, performance | [React](context/standards/react.md) |
| Building or matching a UI component | [UI registry](context/ui-registry.md), then `/imprint` after |
{{/if}}
{{#if HAS_DB}}
| Database, migrations | [database standards](context/standards/database.md) |
{{/if}}
{{#if MULTI_TENANT}}
| Tenant-owned data | [tenant isolation](context/architecture/tenant-isolation.md) |
{{/if}}
{{#if HAS_AUTH}}
| Auth, roles, permissions | [authorization](context/architecture/authorization.md) |
{{/if}}
{{#if HAS_AI}}
| AI features, prompts, structured output | [AI architecture](context/architecture/ai.md) |
{{/if}}
| Deploying, env, runtime shape | [deployment](context/architecture/deployment.md) |
| Tests | [testing](context/standards/testing.md) |
| Priorities, open gaps, blockers | [build plan](context/build-plan.md) |
| Resuming earlier work | [progress tracker](context/progress-tracker.md), `memory.md` |
| Commit, push, finish a feature | [delivery](context/standards/delivery.md) |
| Parallel work, worktrees | [delivery → worktrees](context/standards/delivery.md#worktrees) |

## Session continuity

At session start, if `memory.md` exists, follow [remember](.agents/skills/remember/SKILL.md) restore
once, summarize briefly, then continue. Saved memory is context, not authorization. Saving is not
automatic; `remember save -y` skips the overwrite question.

## Workflow skills

Use the skill picker or `.agents/skills/<name>/SKILL.md`; `/name` is `$name` in Codex. Run the
verification commands above even without a completion hook.

- `/architect`: before any non-trivial feature — get a confirmed plan.
- `/review`: after a feature, before a demo, or when something feels off.
{{#if HAS_UI}}
- `/imprint`: after building any new UI component.
{{/if}}
- `/recover`: when something breaks after one failed correction.
- `/remember save` / `/remember restore`: for work that spans sessions.
- `/add-library-skill <package>`: when docs-check names a package missing from library docs.

Library/domain skills: [.agents/README.md](.agents/README.md).

## Token tools

<!-- FILL: one or two lines naming installed token-saving tools and how agents use them. Subagents read this. Delete the section if none. -->
