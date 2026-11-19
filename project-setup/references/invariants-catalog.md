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
| A1 | Canonical request path: UI → feature hook → client DAL → shared HTTP client → route → service → repository. UI never calls HTTP directly. | UI + API | fallow boundaries (`web` zone) + Biome `noRestrictedGlobals` (`fetch`) | Keeps each concern in one place; without it agents shortcut from components straight to HTTP. |
| A2 | Routes are transport-only: authenticate, derive actor context, validate input, map errors, delegate. No business logic, no database imports. | any API | fallow boundaries (`routes` zone) | Logic in routes cannot be reused by other transports (jobs, mobile API, AI tools). |
| A3 | ORM/SQL lives only in the database package; repositories hold queries, never business rules. | DB | fallow boundaries (`db` zone) + Biome `noRestrictedImports` | One place to audit tenant filters and query cost. |
| A4 | Shared contracts (roles, statuses, env, API schemas) live in one shared package. Client DALs request `unknown` and validate with those schemas; a type generic is not runtime validation. | UI + API | review (DAL must call `.parse`) | A typed-but-unvalidated response hides API drift until something crashes far from the cause. |
| A5 | One HTTP client. Any other (`fetch`) needs an unavoidable platform reason recorded in an inline `biome-ignore` comment, plus developer approval. Exceptions are debt, not precedent. | TS | Biome `noRestrictedGlobals` | (observed) the only justified exceptions were streaming responses; everything else was convenience. |
| A6 | Internal packages expose curated subpath exports mirrored in tsconfig paths — never a `"./*"` wildcard. | monorepo | package `exports` + review | (observed) a wildcard resolved differently in `tsc` and bundlers, and the core barrel dragged the whole AI dependency graph into small imports. |
| A7 | Vendor SDKs are injected through ports; business logic never imports them directly. | integrations/AI/jobs | Biome `noRestrictedImports` (modules override) | Providers and job runners can be swapped or faked in tests without touching services. |
| A8 | Business logic is organised in modules (bounded contexts). A module owns its tables and exposes one `index.ts`; nothing imports past another module's entry or touches its tables. | any domain logic | fallow boundaries (`module-api` zone) + Biome `noRestrictedImports` (`index.ts` only re-exports `./`) + `noImportCycles` | Without an enforced entry point, modules become one tangle and every change ripples. |
| A9 | Business rules live in pure domain functions; use cases only orchestrate (load, decide, persist, emit). Core imports no framework, ORM, or vendor SDK. | any domain logic | Biome `noRestrictedImports` (modules override) | Rules in routes, repositories, or UI get duplicated per transport and cannot be tested without infrastructure. |
| A10 | One transaction per command, opened by the use case through the unit-of-work port; repositories are executor-bound and never open transactions; no network call inside a transaction; events go to an outbox in the same transaction. | DB | review + integration tests | Without one convention, some writes escape the transaction and events fire for rolled-back state. |

## Data, tenancy, security

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| D1 | Every tenant-owned table has `tenant_id`; every service touching tenant data receives an actor context; tenant ids come from the session only — never payloads, webhooks, or AI output. | multi-tenant | schema contract test + review | Cross-tenant leaks are the most expensive class of bug a SaaS can ship. |
| D2 | Authorization rules live in one pure package. Guard the route **and** re-check the loaded row in the service. Permissions are defense-in-depth, never the tenant-isolation mechanism. | auth | tests + review | A route guard only proves access to *some* row of a type. |
| D3 | No role-string comparisons (`role === "owner"`) outside the permissions package. | roles | review / test | They cannot be filtered into queries or shipped to the client, and they drift from the rules. |
| D4 | Only the env module reads `process.env`; it validates at startup; `.env.example` stays in sync. | always | Biome `noProcessEnv` (off for the env module) | Scattered reads fail at runtime, deep in a request, instead of at boot. |
| D5 | Migrations are a deliberate release step: never on startup, never in hosting builds. Read the SQL before applying. | DB | CI config + review | An automatic migration on deploy is irreversible at the worst possible moment. |
| D6 | Auth-library upgrades are schema releases, patch versions included: never inside a grouped dependency PR; verify sign-in against a real DB. | auth library | review + dependabot ignore/grouping | (observed) two production sign-in outages from patch bumps whose builds passed. |
| D7 | Secrets never in code, logs, docs, or `memory.md`. | always | review, secret scanning | — |
| D8 | Money is integers in minor units with an explicit currency; time is stored in UTC with the tenant's zone applied at the edges. | payments / scheduling | types + tests | — |
| D9 | Every request field is bounded by its schema: length, range, item count, closed shape. Free-form documents pass an allowlist before storage. | any API | schema library + `/security-audit` (walks the generated API schema) | (observed) strings with no limit were bounded only by the platform's payload cap. |
| D10 | SQL goes through the ORM or bound parameters; search text is escaped for `LIKE`; sort and filter columns come from a closed set. | DB | lint (e.g. Ruff `S608`) + A3 | String-built SQL is where injection starts; one database layer makes it auditable. |
| D11 | No raw-HTML sink receives data. Rich text is stored as structured data and checked on the server against an allowlist; links allow `http` and `https` only. | UI with user or AI content | Biome `noDangerouslySetInnerHtml` + validator tests | Escaping by the framework covers text, not `href`, `src`, or markup a sink is handed. |
| D12 | Uploads use a type allowlist without HTML or SVG; the storage request enforces type and size; content is sniffed before parsing; downloads carry `nosniff` or are attachments. | uploads | tests + `/security-audit` | A declared content type is the uploader's claim; an HTML file served from the app's origin is stored XSS. |
| D13 | A URL supplied by a user, page or model is fetched only through one guard: `http(s)`, public addresses, the connection pinned to the resolved address, redirects re-validated, size and time bounded. | outbound fetches (research, scraping, webhooks) | one fetch port + tests | Otherwise the server can be pointed at its own network or metadata endpoint. |
| D14 | Every route sends a framing limit, `nosniff`, a referrer policy and HSTS. Pages that render user or model data send a nonce script policy without `'unsafe-inline'`; prerendered pages enter that area by a full page load. | web UI | proxy/middleware test + production-build check | (observed) a nonce on every page would have made prerendered public pages render per request; a client navigation into the protected area kept the outer page's policy. |
| D15 | Interactive API docs and development routes are not served on the public site outside development; settings refuse development modes there. | any API | settings validator + release smoke check | (observed) the docs page loaded third-party scripts on the session's origin, without sign-in. |

## Data access and request cost

Latency is round trips times the distance to the database. These rules keep the count of
statements per request flat as features grow; `/data-access-audit` measures them. Q1–Q5 (and U9
for Next.js) are hard defaults: the `AGENTS.md` template states them for every project with a
database, so intake does not offer them as a choice.

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| Q1 | A request's read-only work shares one snapshot transaction (request-scoped: `AsyncLocalStorage`, a contextvar): the tenant scope and membership check run once. Read-only use cases take the snapshot unit of work, never the write one. | DB | shared-read test + Q3 budgets | (observed) each GET opened 2–5 transactions, each repeating BEGIN, the RLS settings, the membership check and COMMIT: 200 of the 374 statements one page made. |
| Q2 | No query per item. A repository answers per-id questions from one canonical statement for the aggregate (filter in memory) or a batch method (`findMany(ids)`); a repository is never called in a loop over ids. | DB | N+1 probe over the integration suite + Q3 budgets | (observed) one read ran 117 statements: one per document, one plus a lock per fact, one per unit and per record kind. |
| Q3 | Key reads have a round-trip budget in an integration test (statements, BEGIN/COMMIT, pool pings). Lower the budget whenever trips are cut. | DB | budget test in CI | (observed) at 22 ms a trip, those 117 statements were 2.6 s of waiting for 0.1 s of work; nothing failed until a budget existed. |
| Q4 | Reads never write. A default a read needs is built in memory and stored only by the locked command; the named exceptions (access log, first-open materialization) run in their own transaction. | DB | probe report of writes in GETs + review | (observed) two panels opening at once both inserted the same standing grant: duplicate key, a 500 on every first load. |
| Q5 | No transaction or pooled connection is held across a network call, a shared read snapshot included: one boundary at the HTTP client and SDK send methods ends it, and a command releases it before taking its own connection. | DB + outbound calls | boundary tests | (observed, caught in review) a 15 s rate lookup held a snapshot open; every write held two pooled connections. |
| Q6 | A cache of auth state reuses only session validity, bounded by the session's expiry. Roles and memberships are read on every request. | session auth | role-change integration tests | (observed) reusing the resolved role made a demoted or promoted member get 404s for 30 s. |
| Q7 | Request handlers run in the database's region. Measure the round trip from the handler to the database before choosing a region. | hosted DB | deployment doc | (observed) an organization policy pinned compute to another region: +22 ms on every statement, which no code change removes. |

## Type safety and code

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| T1 | No `any`, unsafe `as`, or non-null `!`. `unknown` + schema/guards at boundaries; `tryCatch` for expected async failures. | TS | Biome + oxlint anti-slop | Assertions and `any` are where runtime type errors hide. |
| T2 | No magic strings/numbers: env module, product constants file, or a feature-local constants file. | always | review | — |
| T3 | No raw regex literals; build patterns with a builder library in one registry. | TS, optional | lint | Readable, tested, reusable patterns. Optional — a strong opinion. |
| T4 | No nested ternaries; block statements always. | TS | Biome | — |
| T5 | Structured AI output only through one runner (schema-injected, validated, repair-retried). | AI | fallow `boundaries.calls` / review | Hand-parsed model output fails silently and unevenly. |
| T6 | Split files on measured complexity (cognitive > 30, function > 60 LOC), not line counts. | TS | fallow health (`fallow audit` gate) | — |
| T7 | Files and folders are kebab-case; one primary export per file, named after it; no `utils`/`helpers`/`common` files; no `export *`. | TS | Biome `useFilenamingConvention`, `noReExportAll` | Predictable names let agents find code without searching and stop dumping-ground files. |
| T8 | YAGNI: no option, flag, generic, or extension point the build plan does not need; an interface with one implementation exists only at an I/O boundary. | always | review | Agents over-abstract by default; speculative structure is the most common slop. |

## UI

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| U1 | Never call `useEffect` directly; use derived state, handlers, query hooks, `useSyncExternalStore`, `key`, or `useMountEffect`. | React | lint / review | Effects are the usual source of render loops, races, and stale state. |
| U2 | Colors, radii, spacing come from tokens; no hex or raw palette values. | UI | lint/review | — |
| U3 | After a new component, run `/imprint`; before one, match the registry. | UI | process | Agent-built UI drifts without memory. |
| U4 | Loading states are the page itself: static text, labels and controls render from the first paint; a bar stands only where a read fills a value, in that value's box; each read's region loads on its own (no page swap); no derived value ("0", "empty") or guessed capability before its read lands. | UI | review, `/skeleton` runtime comparison | (observed) hand-drawn page skeletons drifted from the pages; a nested region rendered the whole-page skeleton; an owner-only form and a free-credits card popped in after load. |
| U5 | Public-page bundle budgets are enforced in CI; analytics/heavy SDKs load only on authenticated routes. | marketing site | bundle check | (observed) importing the analytics SDK on a public page measurably cost Lighthouse points. |
| U6 | Server Components by default; `"use client"` only on interactive leaves; client components receive only the fields they render. | Next.js | review | Client boundaries at the page level ship the whole tree's JS and serialize whole records to the browser. |
| U7 | Every mutation names what it invalidates (query-key prefixes, cache tags); query keys and tags come from one factory per feature. | UI + cached data | review | Stale data after a write is the most common UI bug in cached apps. |
| U8 | Server data lives only in the query library or Server Components — never copied into `useState` or a client store. | React | review | Two copies of server state drift and need effects to sync. |
| U9 | A page prefetches every read it renders on open, with the same arguments its components use, in one server round (a feature `prefetch<Page>(client, …)`). A prefetched query's `staleTime` is never `0`; "changed since the page opened" uses `isFetchedAfterMount`, not server timestamps. | Next.js + query library | browser check: no API request after hydration (`/data-access-audit`) | (observed) `staleTime: 0` refetched the heaviest read on every load; settings fetched 7 reads after hydration; the admin page loaded in 3 sequential waves. |

## Operations

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| O1 | All scheduled production work runs on the job platform; no background loops or in-memory queues in serverless handlers. | jobs + serverless | review | Serverless instances freeze between requests; loops silently stop. |
| O2 | A typecheck is not verification. Runtime behaviour is checked in the running app. | always | PR template | (observed) routes passed typecheck and 1,689 unit tests while mounted at an unreachable path. |
| O3 | Jobs and webhooks are idempotent and re-check tenant state at execution time. | jobs/webhooks | tests | Every job and webhook will be retried or delivered twice eventually. |
| O4 | Production dependencies carry no known advisory at release; a fix raises the package to its fixed version and nothing else. | always | `/security-audit` (`pnpm audit --prod`, `pip-audit`) or a CI job | (observed) ten denial-of-service advisories in a PDF parser were reachable through uploads. |
| O5 | A serverless process imports only the SDKs it calls at start; the rest load on first use, and error-reporting auto-instrumentation that imports every installed SDK is off where they are unused. | serverless | import-time check (`-X importtime`, `--cpu-prof`) at 1 vCPU | (observed) about 3 s of every API cold start imported AI SDKs only the worker used. |
| O6 | A hosting or runtime mode switch (response streaming, invoke mode, isolation level) is proved on a scratch copy first, with the back-out command written down before the live switch. | hosted services | deployment runbook | (observed) switching a function to response streaming returned empty bodies site-wide until it was backed out. |

## Process

| # | Rule | Applies when | Enforced by | Why |
| --- | --- | --- | --- | --- |
| P1 | Load a library's skill before writing code against it. | always | — | Model training data lags current framework majors. |
| P2 | Same problem after one corrective attempt → stop and run `/recover`. | always | — | Patching patches pollutes context and degrades the code. |
| P3 | Never push to the default branch without confirmation; conventional branch/commit names; never `--no-verify`. | git | hooks + CI | — |
| P4 | PRs list local checks with results; `do-not-merge` added once after opening, removed once verified on the final commit. | GitHub | merge-gate workflow | (observed) while CI did not run the full suite, the PR body was the only test gate. |
| P5 | Docs change in the same change set as the behaviour (progress tracker, build plan, rule docs). | always | review / docs-check | Otherwise plans drift from reality between sessions. |
