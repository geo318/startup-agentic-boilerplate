# TypeScript

## Strictness

`tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, and
`isolatedModules`. Do not relax them per package to make an error go away.

- No `any`, no unsafe `as`, no non-null `!`. Receive `unknown` at a boundary and narrow it with a
  schema or a type guard. An assertion that is genuinely safe carries a `// SAFETY:` comment
  explaining why.
- A TypeScript generic on an HTTP call (`get<User>()`) is not runtime validation. Request
  `unknown`, then parse with the shared schema.
- Exported functions declare their return types when the inferred type would leak an internal
  shape.

## Errors

- Async work whose failure is expected uses the tuple helper `tryCatch(promise)` →
  `[data, null] | [null, error]` (<!-- FILL: path, e.g. `packages/shared/src/utils/try-catch.ts` -->).
  Use ordinary `try/catch` for transactions, rollbacks, and multi-step recovery.
- Narrow unknown errors with the shared guards (`Guard`, `hasKey`, `getErrorMessage`); never
  `catch (e: any)`.
- When wrapping an error, preserve it: `throw new DomainError("…", { cause: error })`.
- Services throw typed domain errors; the transport layer maps them to status codes in one place.

## Modern syntax

- Immutable array helpers: `toSorted`, `toReversed`, `with`, `at(-1)`. Never `sort()` a shared array.
- `using` / `await using` for anything with a lifecycle (DB clients in scripts, sockets, streams,
  abort controllers) instead of `try/finally` cleanup.
- `structuredClone` over JSON round-trips; `Object.groupBy` over hand-rolled reducers.

## Imports and module boundaries

- Shared packages expose curated subpath exports, listed explicitly in `package.json` `exports`
  and mirrored in tsconfig `paths`. Never a `"./*"` wildcard: it bypasses the public-API boundary
  and resolves differently across bundlers and `tsc`.
- Browser code imports narrow subpaths, never a server-capable barrel.

## Breaking up large files

Split on a measured trigger (cognitive complexity > 30, or a function > 60 lines), not on a line
count you eyeballed. Extract within the same file first; promote to a sibling file only when the
unit is reused or large enough to stand alone. Colocate siblings with their consumer — no shared
`utils/` dumps. Sibling suffixes:

| Suffix | Holds |
| --- | --- |
| `*-model.ts` | State, hooks, submission and derivation logic. No JSX. |
| `*-primitives.tsx` | Presentational subcomponents with no feature logic. |
| `*.server.ts` | Server-only modules (session, secrets). |

Add a new suffix to this table before using it. Don't split a function whose branches share
mutable state, and don't extract a wrapper that is called once and only forwards arguments.
