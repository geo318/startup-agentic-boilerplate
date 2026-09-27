## What and why

<!-- One or two sentences. Link the build-plan item or plan file. -->

## Checks run locally

| Check | Result |
| --- | --- |
| `{{CMD_LINT}}` | |
{{#if TYPESCRIPT}}
| `{{CMD_TYPECHECK}}` | |
{{/if}}
| `{{CMD_TEST_CHANGED}}` | |
| `{{RUNTIME}} scripts/checks/docs-check.mjs` | |
| Runtime verification | <!-- what you exercised, where --> |

Skipped checks and why:

## Docs updated

- [ ] `context/progress-tracker.md` / `context/build-plan.md`
- [ ] Rule docs (`architecture`, `code-standards`, app `AGENTS.md`) if a boundary or rule changed

`do-not-merge` stays on until every relevant check above passed on the final commit.
