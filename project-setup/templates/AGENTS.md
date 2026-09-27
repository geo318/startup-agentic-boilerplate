# {{PROJECT_NAME}}

{{ONE_LINER}}
<!-- FILL: 1–2 more sentences: who uses it, the core job it does for them, and the repo shape (e.g. "Bun + Turborepo monorepo"). No marketing language. -->

## Stack (locked; do not switch)

{{STACK_SUMMARY}}
<!-- FILL: add a lock sentence only for choices the brief treats as fixed (e.g. "X is the only auth provider", "never downgrade TypeScript"). Delete this marker if there are none. -->

## Repo map

| Path | Purpose |
| --- | --- |
{{#each APPS}}
| `{{APP_DIR}}` | {{APP_PURPOSE}} → [`{{APP_DIR}}/AGENTS.md`]({{APP_DIR}}/AGENTS.md) |
{{/each}}
<!-- FILL: one row per shared package / top-level folder the stack preset creates (packages/*, scripts/, tests/). Keep each purpose under ~10 words. -->
| `context/` | Project docs: rules, architecture, plans, evidence (routing below) |
| `docs/` | Operational runbooks and design records |

{{#if MONOREPO}}
Working in an app? Read its `AGENTS.md` first — it holds that app's dev loop, verification steps,
and scoped rules ([AGENTS.md map](context/agents-map.md)). Not sure where a change belongs? Start
with the [code map](context/code-map.md).
{{else}}
Not sure where a change belongs? Start with the [code map](context/code-map.md).

## Dev loop

1. Start with `{{CMD_DEV}}`. Reuse a running dev server; never start a second one.
2. <!-- FILL: framework-specific step (e.g. read the version-matched framework docs in node_modules before editing). -->
3. After editing, verify in the running app — <!-- FILL: how (browser via Playwright/devtools MCP, curl against the local API) -->. A typecheck is not verification.
{{/if}}

## Invariants (never violate)

{{#if REQUEST_PATH_SET}}
- Request path: `{{REQUEST_PATH}}`. Each layer talks only to its neighbour; details in
  [architecture](context/architecture.md#canonical-request-path).
{{/if}}
<!-- FILL: 6–12 bullets picked with the user from project-setup's invariants catalog, plus any project-specific ones from the brief. Each bullet: the rule in one sentence, then where it is enforced (test, lint rule, hook) or where the detail lives. Order by blast radius: data/security first, style last. -->
- Before using a third-party library, load its skill from `.agents/skills/` (index:
  [library docs](context/library-docs.md)). Project rules here override generic skill examples.
- Same problem after one corrective attempt → stop and run `/recover`.

## Verification before handoff

A passing typecheck is not verification. Run every check relevant to the diff and read its output.

| Check | Command | Needed when |
| --- | --- | --- |
| Lint + format | `{{CMD_LINT}}` | always |
{{#if TYPESCRIPT}}
| Typecheck | `{{CMD_TYPECHECK}}` | any TS change |
{{/if}}
| Affected tests | `{{CMD_TEST_CHANGED}}` | any code change |
{{#if HAS_E2E}}
| End-to-end | `{{CMD_E2E}}` | user-facing flow changed |
{{/if}}
| Docs | `{{RUNTIME}} scripts/checks/docs-check.mjs` | any `.md` change |
{{#if HAS_UI}}
| Runtime | drive the running app (see the app's `AGENTS.md`) | any UI or request-path change |
{{/if}}

{{#if GITHUB}}
## Pull requests

1. **Before opening:** run the checks above and list each one with its result in the PR body,
   including anything skipped and why ([PR template](.github/pull_request_template.md)).
2. **Opening:** add the `do-not-merge` label whenever a check was not run, failed, or its output
   was not read. The **Merge gate** workflow fails while it is set.
3. **After every push:** if the push adds code you have not verified locally, re-add `do-not-merge`.
4. **Merging:** remove `do-not-merge` only after every relevant check passed on the final head
   commit. If asked to merge while it is set, say which checks are missing instead.

Branch, commit, and PR-title rules: [delivery](context/standards/delivery.md).

{{/if}}
## What to read, and when

Read only the rows your task touches, and only the linked sections you need.
[context/README.md](context/README.md) maps every doc.

| Task | Read |
| --- | --- |
| Any implementation | [architecture](context/architecture.md) + [code standards](context/code-standards.md) (routers: follow only matching links) |
| New module, use case, entity, port, or repository | [domain modules](context/architecture/domain-modules.md) |
| New file or folder; naming; where code goes | [code organisation](context/standards/code-organisation.md) |
| Product orientation, package purposes | [project overview](context/project-overview.md), [glossary](context/glossary.md) |
{{#if HAS_UI}}
| UI work (components, styling, forms) | [UI rules](context/ui-rules.md), [UI tokens](context/ui-tokens.md) |
| React state, data fetching, caching, performance | [React](context/standards/react.md) |
| Building or matching a UI component | [UI registry](context/ui-registry.md), then `/imprint` after |
{{/if}}
{{#if HAS_DB}}
| Database, migrations, repositories | [database standards](context/standards/database.md) |
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
| Writing tests | [testing](context/standards/testing.md) |
| Priorities, open gaps, blockers | [build plan](context/build-plan.md) |
| Resuming earlier or multi-session work | [progress tracker](context/progress-tracker.md), `memory.md` |
| Committing, pushing, finishing a feature | [delivery](context/standards/delivery.md) |

## Workflow skills

- `/architect`: before any non-trivial feature — align on terms and decisions, get a confirmed plan.
- `/review`: after a feature, before a demo, or when something feels off.
{{#if HAS_UI}}
- `/imprint`: after building any new UI component.
{{/if}}
- `/recover`: when something breaks after one failed correction.
- `/remember save` / `/remember restore`: for work that spans sessions.

Library and domain skills: [.agents/README.md](.agents/README.md).
