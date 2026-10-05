# Context guide

[AGENTS.md](../AGENTS.md) holds global rules; each app's `AGENTS.md` holds scoped rules.
Load only relevant docs below. Linked constraints remain mandatory within their scope.

| Task | Entry point | Details |
| --- | --- | --- |
| Product and package orientation | [Project overview](project-overview.md) | [Glossary](glossary.md) |
| "I want to change X, where do I start?" | [Code map](code-map.md) | Domain ownership, entry points |
| Which AGENTS.md to read for a given app | [AGENTS.md map](agents-map.md) | One line per scoped file |
| Boundaries, data ownership, infrastructure | [Architecture](architecture.md) | `architecture/` |
| Implementation conventions | [Code standards](code-standards.md) | `standards/` |
{{#if HAS_UI}}
| Visual values and component rules | [Tokens](ui-tokens.md), [UI rules](ui-rules.md) | Keep these short and shared |
| Match or capture a component pattern | [UI registry](ui-registry.md) | `ui/`; follow the component link |
{{/if}}
| Choose library guidance | [Library docs](library-docs.md) | [Skill index](../.agents/README.md) |
| Priorities, gaps, blockers | [Build plan](build-plan.md) | `plans/` |
| Previous implementation and evidence | [Progress tracker](progress-tracker.md) | `history/`; read by feature |
| Why a past choice was made | [Decisions](decisions/README.md) | One record per decision |
| Commit, push, finish a feature | [Delivery](standards/delivery.md) | Git conventions, doc hygiene |

Operational procedures and design records are indexed in [docs/README.md](../docs/README.md).

## Doc types

| Kind | Files | Holds | Changes when |
| --- | --- | --- | --- |
| Entry point | `AGENTS.md`, this file | Invariants and routing only | A rule or doc is added/moved |
| Router | `architecture.md`, `code-standards.md` | One heading per topic, each linking a topic file | A topic is added |
| Topic | `architecture/*`, `standards/*`{{#if HAS_UI}}, `ui/*`{{/if}} | The detailed, normative rules | The rule changes |
| Forward state | `build-plan.md`, `plans/*` | Priorities, open gaps, blockers | Priorities change |
| Backward state | `progress-tracker.md`, `history/*` | Dated evidence of what shipped | Work lands |
| Decision | `decisions/*` | Why a hard-to-reverse choice was made | A choice is made or reversed |
| Handoff | `/memory.md` | The latest session's state only | End of a session (`/remember save`) |

## Maintenance

- One rule lives in one place. Entry points and routers link; they do not restate topic rules.
- Match topic filenames to their contents and router headings.
- Keep router headings stable so incoming anchors keep working. When a section moves, update
  incoming links in the same change.
- Status words mean distinct things: **local** (works on a machine), **merged**, **deployed**,
  **verified** (observed working where it matters). Never collapse them.
- Size budgets (enforced as warnings by `scripts/checks/docs-check.mjs`): `AGENTS.md` ≤ 200
  lines, this file ≤ 80, `build-plan.md` ≤ 250, `progress-tracker.md` ≤ 300. Over budget →
  move closed items into `history/<topic>.md` and leave a one-line link.
- Paths in prose/code spans are repository-relative; Markdown links resolve relative to their file.
- Keep reusable skill constraints in `SKILL.md`; move long conditional examples into references
  with explicit reading cues. Never load every reference.
