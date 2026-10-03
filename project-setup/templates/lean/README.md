# {{PROJECT_NAME}}

{{ONE_LINER}}

Install with `{{CMD_INSTALL}}`; run with `{{CMD_DEV}}`.
Run `{{CMD_LINT}}`, `{{CMD_TEST}}`, and `{{RUNTIME}} scripts/checks/docs-check.mjs --strict` before handoff.
{{#if TYPESCRIPT}}
Run `{{CMD_TYPECHECK}}` for TypeScript changes.
{{/if}}

Agent commands and invariants: [AGENTS.md](AGENTS.md). Project context: [context/README.md](context/README.md).

{{#if OWN_HOOKS}}
Keep the existing Git hooks; add the documentation and branch checks to them during setup.
{{else}}
Activate Git hooks with `{{RUNTIME}} scripts/git/conventions.mjs install-hooks`.
{{/if}}
<!-- FILL: required local services and environment variable names; never secret values. -->
