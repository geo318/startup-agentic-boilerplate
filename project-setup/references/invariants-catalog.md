# Invariants catalog

Rules distilled from a production monorepo, generalised. Pick those whose **Applies when** holds, confirm them with
the user, and write each chosen one as a single `AGENTS.md` bullet: the rule, then where it is
enforced or detailed. The **Why** column is for you and the user; keep it out of `AGENTS.md`
unless the reason is what makes people follow it. "(observed)" marks an incident recorded in a
real project; the rest is general rationale.

Prefer invariants that something enforces (a test, lint rule, hook, or CI job). An unenforced
invariant needs to be short and obviously right, or it will erode.

## Architecture and layering

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| A1 | Canonical request path: UI → feature hook → client DAL → shared HTTP client → route → service → repository. UI never calls HTTP directly. | UI + API | contract test | Keeps each concern in one place; without it agents shortcut from components straight to HTTP. |
| A2 | Routes are transport-only: authenticate, derive actor context, validate input, map errors, delegate. No business logic, no database imports. | any API | contract test / lint restricted-imports | Logic in routes cannot be reused by other transports (jobs, mobile API, AI tools). |
| A3 | ORM/SQL lives only in the database package; repositories hold queries, never business rules. | DB | contract test | One place to audit tenant filters and query cost. |
| A4 | Shared contracts (roles, statuses, env, API schemas) live in one shared package. Client DALs request `unknown` and validate with those schemas; a type generic is not runtime validation. | UI + API | contract test (DAL must call `.parse`) | A typed-but-unvalidated response hides API drift until something crashes far from the cause. |
| A5 | One HTTP client. Any other (`fetch`) needs an unavoidable platform reason recorded in the contract-test exception list, plus developer approval. Baseline entries are debt, not precedent. | TS | contract test | (observed) the only justified exceptions were streaming responses; everything else was convenience. |
| A6 | Internal packages expose curated subpath exports mirrored in tsconfig paths — never a `"./*"` wildcard. | monorepo | exports contract test | (observed) a wildcard resolved differently in `tsc` and bundlers, and the core barrel dragged the whole AI dependency graph into small imports. |
| A7 | Vendor SDKs are injected through ports; business logic never imports them directly. | integrations/AI/jobs | contract test | Providers and job runners can be swapped or faked in tests without touching services. |
| A8 | Business logic is organised in modules (bounded contexts). A module owns its tables and exposes one `index.ts`; nothing imports past another module's entry or touches its tables. | any domain logic | contract test (entry rule) + Biome `noImportCycles` | Without an enforced entry point, modules become one tangle and every change ripples. |
| A9 | Business rules live in pure domain functions; use cases only orchestrate (load, decide, persist, emit). Core imports no framework, ORM, or vendor SDK. | any domain logic | contract test (`core-is-framework-free`) | Rules in routes, repositories, or UI get duplicated per transport and cannot be tested without infrastructure. |
| A10 | One transaction per command, opened by the use case through the unit-of-work port; repositories are executor-bound and never open transactions; no network call inside a transaction; events go to an outbox in the same transaction. | DB | review + integration tests | Without one convention, some writes escape the transaction and events fire for rolled-back state. |

## Data, tenancy, security

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| D1 | Every tenant-owned table has `tenant_id`; every service touching tenant data receives an actor context; tenant ids come from the session only — never payloads, webhooks, or AI output. | multi-tenant | schema contract test + review | Cross-tenant leaks are the most expensive class of bug a SaaS can ship. |
| D2 | Authorization rules live in one pure package. Guard the route **and** re-check the loaded row in the service. Permissions are defense-in-depth, never the tenant-isolation mechanism. | auth | tests + review | A route guard only proves access to *some* row of a type. |
| D3 | No role-string comparisons (`role === "owner"`) outside the permissions package. | roles | contract test | They cannot be filtered into queries or shipped to the client, and they drift from the rules. |
| D4 | Only the env module reads `process.env`; it validates at startup; `.env.example` stays in sync. | always | lint / contract test | Scattered reads fail at runtime, deep in a request, instead of at boot. |
| D5 | Migrations are a deliberate release step: never on startup, never in hosting builds. Read the SQL before applying. | DB | CI config + review | An automatic migration on deploy is irreversible at the worst possible moment. |
| D6 | Auth-library upgrades are schema releases, patch versions included: never inside a grouped dependency PR; verify sign-in against a real DB. | auth library | review + dependabot ignore/grouping | (observed) two production sign-in outages from patch bumps whose builds passed. |
| D7 | Secrets never in code, logs, docs, or `memory.md`. | always | review, secret scanning | — |
| D8 | Money is integers in minor units with an explicit currency; time is stored in UTC with the tenant's zone applied at the edges. | payments / scheduling | types + tests | — |

## Type safety and code

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| T1 | No `any`, unsafe `as`, or non-null `!`. `unknown` + schema/guards at boundaries; `tryCatch` for expected async failures. | TS | Biome + oxlint anti-slop | Assertions and `any` are where runtime type errors hide. |
| T2 | No magic strings/numbers: env module, product constants file, or a feature-local constants file. | always | review | — |
| T3 | No raw regex literals; build patterns with a builder library in one registry. | TS, optional | lint / contract test | Readable, tested, reusable patterns. Optional — a strong opinion. |
| T4 | No nested ternaries; block statements always. | TS | Biome | — |
| T5 | Structured AI output only through one runner (schema-injected, validated, repair-retried). | AI | contract test | Hand-parsed model output fails silently and unevenly. |
| T6 | Split files on measured complexity (cognitive > 30, function > 60 LOC), not line counts. | TS | fallow ratchet | — |
| T7 | Files and folders are kebab-case; one primary export per file, named after it; no `utils`/`helpers`/`common` files; no `export *`. | TS | Biome `useFilenamingConvention`, `noReExportAll` | Predictable names let agents find code without searching and stop dumping-ground files. |
| T8 | YAGNI: no option, flag, generic, or extension point the build plan does not need; an interface with one implementation exists only at an I/O boundary. | always | review | Agents over-abstract by default; speculative structure is the most common slop. |

## UI

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| U1 | Never call `useEffect` directly; use derived state, handlers, query hooks, `useSyncExternalStore`, `key`, or `useMountEffect`. | React | lint / review | Effects are the usual source of render loops, races, and stale state. |
| U2 | Colors, radii, spacing come from tokens; no hex or raw palette values. | UI | lint/review | — |
| U3 | After a new component, run `/imprint`; before one, match the registry. | UI | process | Agent-built UI drifts without memory. |
| U4 | Placeholders are the size of what replaces them; static text never skeletons. | UI | review | Prevents layout shift. |
| U5 | Public-page bundle budgets are enforced in CI; analytics/heavy SDKs load only on authenticated routes. | marketing site | bundle check | (observed) importing the analytics SDK on a public page measurably cost Lighthouse points. |
| U6 | Server Components by default; `"use client"` only on interactive leaves; client components receive only the fields they render. | Next.js | review | Client boundaries at the page level ship the whole tree's JS and serialize whole records to the browser. |
| U7 | Every mutation names what it invalidates (query-key prefixes, cache tags); query keys and tags come from one factory per feature. | UI + cached data | review | Stale data after a write is the most common UI bug in cached apps. |
| U8 | Server data lives only in the query library or Server Components — never copied into `useState` or a client store. | React | review | Two copies of server state drift and need effects to sync. |

## Operations

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| O1 | All scheduled production work runs on the job platform; no background loops or in-memory queues in serverless handlers. | jobs + serverless | review | Serverless instances freeze between requests; loops silently stop. |
| O2 | A typecheck is not verification. Runtime behaviour is checked in the running app. | always | PR template | (observed) routes passed typecheck and 1,689 unit tests while mounted at an unreachable path. |
| O3 | Jobs and webhooks are idempotent and re-check tenant state at execution time. | jobs/webhooks | tests | Every job and webhook will be retried or delivered twice eventually. |

## Process

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| P1 | Load a library's skill before writing code against it. | always | — | Model training data lags current framework majors. |
| P2 | Same problem after one corrective attempt → stop and run `/recover`. | always | — | Patching patches pollutes context and degrades the code. |
| P3 | Never push to the default branch without confirmation; conventional branch/commit names; never `--no-verify`. | git | hooks + CI | — |
| P4 | PRs list local checks with results; `do-not-merge` until verified on the final commit. | GitHub | merge-gate workflow | (observed) while CI did not run the full suite, the PR body was the only test gate. |
| P5 | Docs change in the same change set as the behaviour (progress tracker, build plan, rule docs). | always | review / docs-check | Otherwise plans drift from reality between sessions. |
