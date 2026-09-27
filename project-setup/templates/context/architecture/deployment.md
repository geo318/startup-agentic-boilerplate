# Deployment and runtime

## Environments

| Environment | Hosting | Deployed from | Data |
| --- | --- | --- | --- |
<!-- FILL: rows for local, preview (if any), production — hosting target per app, trigger (push to main, manual), and which database/branch each uses. Unknowns → build-plan "Open questions". -->

## Environment variables

- One module reads the process environment and validates it at startup
  (<!-- FILL: path, e.g. `packages/shared/src/env.ts` -->). Nothing else reads it.
- `.env.example` lists every variable with a comment; update it in the same change that adds one.
- Server-only secrets never reach browser code; client-exposed variables use the framework's
  public prefix and are listed separately.

{{#if HAS_DB}}
## Migrations

Migrations are a deliberate release step: never run on app startup, never inside a hosting
provider's build. See [database standards](../standards/database.md#migrations).

{{/if}}
{{#if HAS_JOBS}}
## Scheduled and background work

<!-- FILL: the job platform (e.g. Trigger.dev, a queue) and the rule that all scheduled production work lives there. -->
- No background loops, timers, or in-memory queues inside serverless request handlers.
- Jobs are idempotent and re-check tenant/entitlement state at execution time.

{{/if}}
## Runtime verification

A deploy is verified when the changed behavior is observed working in that environment, not when
the build succeeds. Record what was observed, where, and when in the progress tracker.
