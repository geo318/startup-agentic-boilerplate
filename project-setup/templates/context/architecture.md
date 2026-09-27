# Architecture

Read the boundary reference for the area you are changing before changing it. These references are
normative; load only the affected topics. Paths are relative to the repository root.

## Layout

```
<!-- FILL: the directory tree from the stack preset, one line per app/package with a ≤8-word purpose. Must match the repo map in AGENTS.md. -->
```

## Layer rules

<!-- FILL: 4–8 bullets, one per layer the stack preset defines: what it owns and what it must never do/import (e.g. "Routes are transport-only: authenticate, validate, map errors, delegate. No business logic, no database imports."). -->

{{#if REQUEST_PATH_SET}}
## Canonical request path

New and touched features follow this dependency direction:

`{{REQUEST_PATH}}`

<!-- FILL: one bullet per hop, stating its responsibility and its location in this repo (e.g. "Client DAL — `apps/web/src/features/<feature>/api.ts`; requests `unknown` and validates the response with a shared schema"). End with the approved-exceptions rule: where exceptions are recorded (architecture contract test baseline) and that baseline entries are debt, not precedent. -->

{{/if}}
{{#if MULTI_TENANT}}
## Tenant isolation

Read [Tenant isolation](architecture/tenant-isolation.md) before touching tenant-owned data.

{{/if}}
{{#if HAS_AUTH}}
## Authorization

Read [Authorization](architecture/authorization.md) before touching auth, roles, or permissions.

{{/if}}
{{#if HAS_AI}}
## AI

Read [AI architecture](architecture/ai.md) before adding a prompt, model call, agent, or tool.

{{/if}}
## Deployment and runtime

Read [Deployment](architecture/deployment.md) before changing env, build, hosting, migrations, or
scheduled work.

## Adding a topic

Add a `## Heading` here with one sentence and a link to `architecture/<topic>.md`, named for its
content. Keep this file a router; the rules live in the topic file.
