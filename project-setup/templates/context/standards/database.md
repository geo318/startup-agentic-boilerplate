# Database

<!-- FILL: database + ORM, where schema lives, where repositories live, and the migration commands (generate / migrate / check / studio) as a bash block. -->

## Ownership

- Schema, client, migrations, and repositories live in one package/folder
  (<!-- FILL: path -->). No ORM or SQL imports anywhere else.
- Repositories own queries and persistence mapping only: no HTTP, no authorization decisions, no
  business rules. Use cases own transactions through the unit of work
  ([domain modules](../architecture/domain-modules.md#transactions-unit-of-work)).
- Each module's tables are read and written only by that module's repositories. A join across
  module boundaries belongs in a read model the owning module exposes, not in another module's
  query.
- Every column that can be null says why in the schema, or is made non-null.
{{#if MULTI_TENANT}}
- Every tenant-owned table has a non-null tenant column and an index that starts with it. See
  [tenant isolation](../architecture/tenant-isolation.md).
{{/if}}

## Migrations

- Generated from the schema, reviewed as SQL, committed with the change that needs them.
- A deliberate release step: never on app startup, never inside a hosting build.
- Before applying, read the SQL: look for `DROP`, `DELETE`, `TRUNCATE`, type changes, and
  `NOT NULL` additions on populated tables. Destructive or locking changes get a written rollout
  (expand → backfill → contract) in `docs/`.
- Branches that both generate migrations from the same parent fork the migration chain. Rebase on
  `{{DEFAULT_BRANCH}}`, regenerate, and re-run the chain check before pushing. Never rename
  migration files by hand to dodge a number clash.
- When a "what is applied" check and the database disagree, believe the database: query it.

## Queries

- Select only the columns a caller needs for list endpoints; paginate every list.
- Put constraints (unique, foreign key, check, exclusion) in the database, not only in code.
- A transaction lives in one use case (`uow.run`); never hold one open across a network call.

## Request cost

Every statement is a round trip to the database; latency is their count times the distance.
Measure with [data-access-audit](../../.agents/skills/data-access-audit/SKILL.md).

- **One read transaction per request.** A request's read-only work joins one request-scoped
  snapshot (`AsyncLocalStorage` holder, opened by request middleware): the scope{{#if MULTI_TENANT}}, tenant{{/if}} and
  membership checks run once, and a repeated query returns the rows it already read. Read-only
  use cases take the snapshot unit of work, never the write one.
- **A command keeps its own transaction.** Opening it ends the shared snapshot (one connection
  per request at a time); a read after the commit takes a new snapshot that sees it.
- **No query per item.** A repository answers per-id questions from one canonical statement for
  the aggregate and filters in memory, or takes a batch (`findMany(ids)`). Never call a
  repository in a loop over ids; never lock rows one at a time in a loop.
- **Reads never write.** A default a read needs is built in memory and stored only by the locked
  command. Name the exceptions here (access log, first-open materialization); each runs in its
  own transaction.
- **No transaction across a network call**, the shared snapshot included: the HTTP client's and
  SDKs' send methods end it first.
- **Budgets.** Key reads have a statement budget (statements, BEGIN/COMMIT, pool pings) in an
  integration test; lower it whenever trips are cut, never raise it to pass.

## Repositories

- One repository per aggregate: `<db>/repositories/<module>/<entity>-repository.ts`, created by
  `create<Entity>Repository(executor)` so the same code runs inside or outside a transaction.
- Methods are named for the domain question (`findOverdue`, `save`), return domain types, and map
  rows inside the repository. ORM row types never leave it.
- A repository never opens a transaction, reads the clock, or calls another repository.

## Caching reads

- Add a cache only after measuring a slow or expensive read, and record where it lives.
- The use case that changes the data invalidates its cache entry in the same change set; name the
  invalidation next to the write.
- Cache keys include every input that changes the result{{#if MULTI_TENANT}}, and always the tenant
  id{{/if}}. Never cache an authorization decision across users.
- The database stays the source of truth: a cache miss or outage degrades speed, never correctness.
