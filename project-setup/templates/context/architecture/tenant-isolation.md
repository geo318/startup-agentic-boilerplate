# Tenant isolation

<!-- FILL: one sentence naming the tenant unit in this product (e.g. "workspace", "organization", "salon") and the glossary term used for it. -->

## Rules

- Every tenant-owned table has a non-null `tenant_id` (or the project's equivalent) and every
  query on it filters by that column. Platform-owned tables say so in a schema comment.
- Every service that touches tenant data receives an actor context (tenant id + user id +
  permissions) derived from the authenticated session.
- Tenant ids come from the session only — never from request payloads, URL params trusted without
  a membership check, webhooks, or AI output.
- Repository methods take `tenantId` explicitly. Authorization rules are defense-in-depth on top
  of that filter, never the isolation mechanism itself.
- Webhooks resolve the tenant from a signed, stored mapping (e.g. provider account id → tenant),
  not from a field the sender controls.
- Background jobs carry the tenant id they were enqueued with and re-check that the tenant is
  still active/entitled when they run.
- Caches and storage keys that hold tenant data include the tenant id in the key.

## Verification

<!-- FILL: how isolation is tested here — e.g. a repository contract test that every tenant table has tenant_id, and an integration test proving tenant A cannot read tenant B's row through each route. Mark "(planned)" until they exist and add them to the build plan. -->
