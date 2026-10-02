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
- For unfamiliar library APIs, read the relevant [library docs](context/library-docs.md) or installed skill.
  Project rules override generic examples; installing or loading a skill is not required for every dependency.
- Same problem after one corrective attempt → stop and run `/recover`.
- Questions: ask in plain text and end the turn — never `AskUserQuestion` or plan-approval dialogs
  (they block the session). Ask only when the answer changes the implementation and neither docs nor
  code settle it; give your recommended option first. For small choices, don't ask: say
  `Assumed: X (alternative: Y)` and continue. Irreversible actions (deleting data, force-push,
  publishing, spending money) always need an explicit yes.

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
{{#if TYPESCRIPT}}
| Architecture, dead code, duplication, complexity | `{{CMD_FALLOW}}` | any code change |
{{/if}}
| Docs | `{{RUNTIME}} scripts/checks/docs-check.mjs` | any `.md` or `package.json` change |
{{#if HAS_UI}}
| Runtime | drive the running app (see the app's `AGENTS.md`) | any UI or request-path change |
{{/if}}

{{#if GITHUB}}
{{#if AGENTIC_RUNTIME}}
## Managed workflow

Model routing lives in `.agents/models.json`: `execution: "handoff"` means answer the printed JSON packets in the chosen harness;
`"delegated"` invokes configured providers. Never infer the worker model from this chat's model selector.
Run `node scripts/agentic.mjs task preflight <id>` before a task; report configured identities and qualification sources accurately.
Keep the controller running while answering handoff packets; reviewer packets require a separate context/person.
After a pre-edit budget stop, retain the history and create a smaller replacement contract under the existing authorization;
keep required approvals/checks. An authorized runtime/routing upgrade is maintenance, not a refused-task bypass.

On by default (`"enabled": true` in `.agents/policy.json`). When on, non-trivial changes go through `node scripts/agentic.mjs task …` so the
controller runs the checks, grounds context in real source, and records evidence, instead of trusting a model's own claim that it works.
Never turn it off, edit `.agents/`, or work around a refused task to get a change through; ask the person. Check state with
`node scripts/agentic.mjs doctor`. Before handoff, run `node scripts/agentic.mjs session-check` to run required gates and record the result; fix failures. Claude Code also runs this through its optional Stop hook. After opening a PR, run `node scripts/agentic.mjs pr-summary --update` once (later pushes do it from the pre-push hook). Use `node scripts/agentic.mjs disable` when the user asks to turn it off.

{{/if}}
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
| Starting parallel work; branch ↔ worktree mapping; cleaning up worktrees | [delivery → worktrees](context/standards/delivery.md#worktrees) |

## Workflow skills

Use the harness’s skill picker, or read `.agents/skills/<name>/SKILL.md` directly. The `/name`
notation below names a skill; Codex uses `$name`. Run the verification commands above even
when the harness has no completion hook.

- `/architect`: before any non-trivial feature — align on terms and decisions, get a confirmed plan.
- `/review`: after a feature, before a demo, or when something feels off.
{{#if HAS_UI}}
- `/imprint`: after building any new UI component.
{{/if}}
- `/recover`: when something breaks after one failed correction.
- `/remember save` / `/remember restore`: for work that spans sessions.
- `/add-library-skill <package>`: only when docs-check names a package missing from library docs.

Library and domain skills: [.agents/README.md](.agents/README.md).

## Token tools

<!-- FILL: one or two lines naming the token-saving tools installed on this machine and how agents use them, e.g. "Shell output is condensed by rtk; re-run as `rtk proxy <cmd>` only if it looks unusable. Keep diffs minimal (ponytail)." Subagents read this too. If none are installed, delete this whole section. -->
