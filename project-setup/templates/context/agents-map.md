# AGENTS.md map

Every directory-scoped `AGENTS.md` in the repo, what it covers, and when to read it. A scoped file
adds to the root file's invariants — it never overrides them. Read the root file first, then the
scoped file for whatever you are touching.

| File | Scope | Read it for |
| --- | --- | --- |
| [`AGENTS.md`](../AGENTS.md) | Whole repo | Stack, repo map, invariants, verification, and the task → doc routing table. Always first. |
{{#each APPS}}
| [`{{APP_DIR}}/AGENTS.md`](../{{APP_DIR}}/AGENTS.md) | `{{APP_DIR}}` | {{APP_FRAMEWORK}} dev loop, verification, and rules scoped to {{APP_NAME}}. |
{{/each}}

`CLAUDE.md` files contain only `@AGENTS.md`, so every agent reads the same source.

## Maintenance

Add a row whenever a directory gets its own `AGENTS.md` (a new app, or a package big enough to need
scoped rules). Keep each summary to what makes the file worth opening, not a restatement of it.
