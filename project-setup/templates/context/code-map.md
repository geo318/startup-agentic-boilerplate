# Code map

"I want to change X — where do I start?" Domain ownership and entry points, not a file catalog.
Rules that apply everywhere live in [architecture.md](architecture.md) and
[code-standards.md](code-standards.md); this map only points, it does not repeat them.

| Working on | Business logic | UI / transport entry | Related |
| --- | --- | --- | --- |
<!-- FILL: one row per product area from project-overview.md, using the folder convention of the stack preset (e.g. `packages/core/src/<domain>/`, `apps/web/src/features/<feature>/`). Areas not built yet still get a row with the planned path and "(planned)". -->

## Infrastructure

<!-- FILL: bullets for cross-cutting owners that exist in this stack — env/config, shared contracts, database + migrations, auth, telemetry, scheduled jobs, deployment, operational scripts — each pointing at its folder and governing doc. -->

## Maintenance

Folders express ownership; this map explains relationships across them. Update both when ownership
changes — a move without a map update, or a map update without the move, is a bug.
