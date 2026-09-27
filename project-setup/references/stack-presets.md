# Stack presets

A preset fixes the repository shape, the request path, default flags, commands, and which code
scaffolding to run. Pick one at intake; the brief may override any part of it. Versions below are
the reference production stack ran in 2026-09 — **check the current stable release of each before scaffolding** and
record what you actually installed.

Always scaffold code with the framework's official generator (it knows current versions), then
add the skeleton by hand. Generators refuse non-empty directories: run them **before** rendering
the docs, into a sub-folder (`apps/web`), or — for a root-level app, or when the skill itself is
installed in the project's `.claude/` — into a temporary sibling directory whose contents you
then move in (never overwrite files that already exist; merge `.gitignore` and `package.json`).

---

## `ts-monorepo` — multi-app monorepo

For: products with more than one deployable (web + API, optionally mobile and workers) sharing
business logic.

```
apps/
  web/          Next.js App Router — public site + authenticated app
  api/          Elysia (or Hono) on Bun — transport-only routes
  mobile/       Expo — optional
  worker/       local job wrappers — optional (production jobs: Trigger.dev or similar)
packages/
  core/         domain modules (src/<module>/: domain, use cases, ports); no framework or ORM imports
  db/           schema, migrations, client, repositories (the only ORM importer)
  shared/       env module, Zod contracts, statuses, roles, guards, tryCatch
  config/       product constants
  permissions/  authorization rules — pure, isomorphic, no deps
  ui/           shared UI primitives
```

- **Request path:** `UI → feature hook → client DAL → shared HTTP client → route → core service → repository`
- **Flags:** `MONOREPO, TYPESCRIPT, BUN, HAS_UI, NEXTJS, HAS_DB, HAS_AUTH, REQUEST_PATH_SET, GITHUB,
  CLAUDE_CODE` on; `MULTI_TENANT`, `HAS_AI`, `HAS_JOBS`, `HAS_E2E` per brief.
- **Reference stack line:** Bun + Turborepo · Next.js 16 App Router · Elysia on Bun · Expo SDK 54 ·
  Better Auth · Drizzle + Postgres (Neon) · Zod v4 · TanStack Query · Axios · Tailwind v4 +
  shadcn-style primitives · Biome · Vitest + Playwright · Trigger.dev · TypeScript 7 (`tsgo`).
- **Commands:** `bun install`, `bun run dev` (web + api together), `bun run lint` (= `biome check .`),
  `bun run format`, `bun run typecheck` (= `turbo run typecheck`), `bun run test`
  (`vitest run`), `bunx vitest run --changed origin/main`, `bun run test:e2e` (Playwright).
- **Scaffold:**
  1. `bunx create-turbo@latest . --package-manager bun` (or `bun init` + workspaces by hand);
     remove the generator's sample apps/packages you will not use.
  2. `bunx create-next-app@latest apps/web --ts --app --tailwind --biome --use-bun --no-src-dir`
     (adjust flags to the current CLI; say no to ESLint).
  3. API app: `bun create elysia apps/api` or a hand-made package with `src/index.ts`.
  4. Mobile (optional): `bunx create-expo-app@latest apps/mobile`.
  5. Create `packages/{core,db,shared,config,permissions,ui}` with `package.json` names
     `<scope>/<name>`, curated `exports`, and `tsconfig.json` extending `../../tsconfig.base.json`.
  6. Skeleton: `packages/shared/src/env.ts` (validated env), `packages/shared/src/utils/{try-catch,guards}.ts`
     (from `snippets/ts/`), one shared HTTP client in web, and a first vertical slice — `GET /health`
     route → `HealthService` → no-op repository — wired end to end with one unit test per layer.
     Then the domain skeleton from `context/architecture/domain-modules.md`: the shared kernel
     (`packages/core/src/shared/`: `DomainError`, `Clock`, `UnitOfWork`), `createUnitOfWork` and
     `createRepositories(executor)` in `packages/db`, and the composition root in `apps/api`. The
     first real module follows the module anatomy so later modules copy a working example.
  7. `packages/core/src/architecture-contract.unit.test.ts` from `snippets/ts/`, rules edited to
     this repo's scope and layers.
- **Root `package.json` scripts to add:** `"prepare": "bun scripts/git/conventions.mjs install-hooks"`,
  `"docs:check": "bun scripts/checks/docs-check.mjs"`,
  `"git:check-current-branch": "bun scripts/git/conventions.mjs current"`, `lint`, `format`,
  `typecheck`, `test`, `test:e2e`.
- **Lessons baked in:** transaction passing is decided on day one (unit of work), not per
  feature; web `dev` alone fails if web proxies `/api` to the API — `dev`
  starts both; migrations never in builds; auth-library bumps are schema releases; curated
  subpath exports only; browser code imports narrow `shared/<domain>` subpaths, never the barrel.

---

## `next-fullstack` — single Next.js app

For: one web product where route handlers / server actions are enough as the API.

```
src/
  app/                    routes; route handlers and server actions are transport-only
  features/<feature>/     components, hooks.ts, queries.ts, api.ts (client DAL)
  server/
    modules/<module>/     domain/, use-cases/, queries/, ports.ts, errors.ts, index.ts
    modules/shared/       shared kernel: DomainError, Clock, UnitOfWork
    db/                   schema, client, migrations, unit of work, repositories/<module>/
    composition.ts        wires use cases to repositories and adapters
  shared/                 env, Zod contracts, guards, tryCatch, constants
  components/ui/          primitives
```

- **Request path:** `UI → feature hook → client DAL → route handler / server action → use case → repository`
- **Flags:** `MONOREPO: false`, `apps: []`, `TYPESCRIPT, HAS_UI, NEXTJS, REQUEST_PATH_SET` on; others per brief.
- **Commands:** from the package manager chosen (`pnpm`/`bun`); `lint` = `biome check .`.
- **Scaffold:** `create-next-app` at the root (before rendering docs), then the `src/server` and
  `src/shared` skeleton, the snippets, and contract-test rules: `src/app` and `src/features` never
  import `src/server/db` or the ORM; `src/server/modules` imports no framework or ORM; the entry
  rule's `roots` are `src/server/modules` and `src/features`.

---

## `api-service` — single backend service

For: an API, worker, or integration service with no UI.

```
src/
  routes/          transport: auth, validation, error mapping
  modules/<module>/  domain/, use-cases/, queries/, ports.ts, errors.ts, index.ts
  db/              schema, client, migrations, unit of work, repositories/<module>/
  adapters/        third-party clients behind ports
  composition.ts   wires use cases to repositories and adapters
  shared/          env, contracts, guards
```

- **Request path:** `route → use case → repository` (and `use case → adapter port` for vendors)
- **Flags:** `MONOREPO: false`, `apps: []`, `HAS_UI: false`, `TYPESCRIPT, REQUEST_PATH_SET` on.
- **Scaffold:** `bun init` / `npm init`, the framework (Elysia, Hono, Fastify), the snippets, a
  `/health` slice, and the contract test (routes never import repositories or the ORM).

---

## `docs-only` — any stack, or not decided yet

For: non-TypeScript stacks (Python, Go, Rust…), or when the user wants the documentation system
before choosing tools.

- **Flags:** `TYPESCRIPT: false`, `REQUEST_PATH_SET` only if the layering is agreed; `BUN: false`,
  `RUNTIME: "node"` (the generated `.mjs` scripts need Node ≥ 18 even in a non-JS repo).
- **Commands:** use the ecosystem's (`uv run ruff check`, `uv run pytest`, `go test ./...`, …).
  `CMD_TYPECHECK` may repeat the lint command if the language has no separate step
  (with `TYPESCRIPT: false` the typecheck rows are omitted anyway).
- **Scaffold:** none. `biome.json`, `tsconfig.base.json` and `context/standards/typescript.md`
  are not rendered; write the equivalent language standard as `context/standards/<language>.md`
  and link it from `code-standards.md`.
