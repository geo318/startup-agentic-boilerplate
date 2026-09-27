# Authorization

<!-- FILL: the auth provider and session model (cookie session, JWT, API keys), who owns identity tables, and how an app user row links to the provider's user row. -->

## Roles

| Role | Can | Cannot |
| --- | --- | --- |
<!-- FILL: one row per role from the brief. -->

## Rules

- All authorization rules live in one place (a permissions module/package), written as pure,
  dependency-free functions so the same rules can ship to the client for UI gating.
- Guard the route (the caller may act on *some* row of this type), then re-check the loaded row in
  the service (the caller may act on *this* row). A route guard alone is not row-level authorization.
- Filter lists through the same rules (e.g. an ability → query-condition helper), not by
  post-filtering in the UI.
- Never compare role strings outside the permissions module (`role === "owner"`); ask the rules.
- Client-side checks are UX only. The server decides.
- Auth-library upgrades are schema releases, including patch versions: read the changelog, check
  its schema/migration notes, and verify sign-in and session lookup against a real database before
  merging. A passing build proves nothing about auth.

## Dev identity

<!-- FILL: how local development authenticates (seeded dev user, dev fallback gated to development env only) and how to create a real login. If there is a dev fallback, state the exact guard that keeps it out of production. -->
