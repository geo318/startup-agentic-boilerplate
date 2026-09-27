# Code standards

Read the relevant standard before editing that kind of code. Linked rules remain mandatory for
their scope.

## Do

- Keep transport handlers thin — authenticate, validate, map errors, delegate to a service.
- Parse untrusted data at boundaries (env, request input, webhooks, third-party and AI responses)
  with a schema. Pass typed values inward.
- Prefer boring, explicit code over clever abstractions. Three similar lines beat a premature helper.
- Load a library's skill from `.agents/skills/` before writing code against that library.
<!-- FILL: 0–4 project-specific "do" bullets from the brief or chosen invariants. Delete this marker if none. -->

## Don't

- Don't put business logic in route handlers, UI components, or repositories.
- Don't read the process environment outside the env module.
- Don't add magic strings or numbers to implementation code — see [constants](#constants).
- Don't nest ternaries; use `if`/`switch` or a named helper.
- Don't add a new dependency when the platform or an existing dependency already does the job.
<!-- FILL: 0–4 project-specific "don't" bullets. Delete this marker if none. -->

## Constants

- Deployment-specific values → the env module.
- Product/app configuration → <!-- FILL: path, e.g. `packages/config/src/constants.ts` -->.
- Values private to one feature → a `constants.ts` beside that feature.
- Test fixtures may use literals only when the literal is the subject of the assertion.

## Comments

- Write no comments by default. Add one only when the *why* is non-obvious: a hidden constraint, a
  subtle invariant, a workaround for a specific bug.
- Never describe *what* the code does; names do that.

{{#if TYPESCRIPT}}
## TypeScript

Read [TypeScript](standards/typescript.md) before writing TypeScript: strictness, boundary parsing,
error handling, modern syntax, and when to split a file.

{{/if}}
{{#if HAS_DB}}
## Database

Read [Database](standards/database.md) before changing schema, migrations, or repositories.

{{/if}}
## Testing

Read [Testing](standards/testing.md) before writing or moving tests.

## Delivery

Read [Delivery](standards/delivery.md) before committing, pushing, opening a PR, or marking work
complete: branch/commit conventions, PR protocol, and documentation hygiene.
