# Database

<!-- FILL: database + ORM, where schema lives, where repositories live, and the migration commands (generate / migrate / check / studio) as a bash block. -->

## Ownership

- Schema, client, migrations, and repositories live in one package/folder
  (<!-- FILL: path -->). No ORM or SQL imports anywhere else.
- Repositories own queries and persistence mapping only: no HTTP, no authorization decisions, no
  business rules. Services orchestrate transactions through repository methods.
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
- A transaction lives in one service method; never hold one open across a network call.
