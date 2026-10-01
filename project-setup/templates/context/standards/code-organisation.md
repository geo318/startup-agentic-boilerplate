# Code organisation

Where a new file goes, what it is called, how a module exposes itself, and when to split a file.
Layers and their dependency direction are in [architecture](../architecture.md); the inside of a
business module is in [domain modules](../architecture/domain-modules.md).

## Where new code goes

| You are adding | It goes in |
| --- | --- |
<!-- FILL: one row per kind of code, with this repo's real path — at least: business rule / invariant (module `domain/`), command (`<module>/use-cases/<verb>-<noun>.ts`), read for a screen or endpoint (`<module>/queries/`), persistence (repository), third-party integration (adapter behind a port), request/response schema (shared contracts), HTTP endpoint (route, transport only), UI for a product area (the app's `features/<feature>/`), UI primitive with no product logic (UI package/folder), env var (env module), product constant (constants file). Drop rows the stack does not have. -->
| Something only one file uses | That file, or a sibling beside it — not a shared folder |

When nothing fits, ask before creating a new top-level folder, and record the answer here.

## Naming

- Files and folders are kebab-case ASCII: `invoice-repository.ts`, `use-invoices.ts`.
  Framework-reserved names are exempt (`page.tsx`, `[id]`, `(group)`, `_layout.tsx`){{#if TYPESCRIPT}};
  {{#if OWN_LINTER}}oxlint `unicorn/filename-case`{{else}}Biome `useFilenamingConvention`{{/if}} enforces it{{/if}}.
- A file has one primary export, named after the file: `void-invoice.ts` → `makeVoidInvoice`,
  `invoice-card.tsx` → `InvoiceCard`, `use-invoices.ts` → `useInvoices`.
- Name for the domain, not the pattern or the technology: `invoice-repository.ts`, not
  `drizzle-helpers.ts`. Never `utils`, `helpers`, `common`, `misc`, `manager`, or `stuff` as a
  file or folder name.
- Functions start with a verb; booleans read as questions (`isPaid`, `hasAccess`); event props are
  `onX` and their handlers `handleX`.
- Glossary terms are used exactly, in code and in file names.

{{#if TYPESCRIPT}}
### Suffixes

| Suffix | Holds |
| --- | --- |
| `*-model.ts` | State, hooks, submission and derivation logic. No JSX. |
| `*-primitives.tsx` | Presentational subcomponents with no feature logic. |
| `*.server.ts` | Server-only modules (session, secrets, cached loaders). |
| `*-repository.ts` | One aggregate's persistence adapter. |
| `*.unit.test.ts` / `*.integration.test.ts` | Tests, beside the file they test. |

Add a suffix to this table before using it.

{{/if}}
{{#if HAS_UI}}
## Feature folders (UI apps)

```
features/<feature>/
  index.ts          public API: what routes and other features may import
  api.ts            client DAL: HTTP calls; parses responses with the shared schemas
  queries.ts        `queryOptions` factories (key + fetcher + staleTime) and cache tags
  hooks.ts          query and mutation hooks — the only data entry point for components
  components/       feature components; `<name>.tsx`, plus `<name>-model.ts` when logic grows
  constants.ts      values private to this feature
```

- Routes and pages compose features: they read params, choose layout, and render feature
  components. They hold no business logic and no inline data calls.
- Features do not import each other's internals. Prefer composing two features in the page; when
  one must use another, import only its `index.ts`, and never in both directions.
- A component used by two features moves up to the app's shared components; one with no product
  logic moves to the UI primitives. Never sideways into another feature.

{{/if}}
## Module entry points and imports

- Every module and feature has one entry, `index.ts`, with explicit named exports. `export *` is
  banned{{#if TYPESCRIPT}} ({{#if OWN_LINTER}}oxlint `oxc/no-barrel-file`{{else}}Biome `noReExportAll`{{/if}}){{/if}}; the entry lists exactly what is public.
- From outside, import only the entry{{#if TYPESCRIPT}} (fallow boundaries in `.fallowrc.json`){{/if}}.
- An `index.ts` re-exports only its own folder (`./…`), never `../`{{#if TYPESCRIPT}} (lint
  `no-restricted-imports` on `*/index.ts`){{/if}}; it is a door, not a shortcut into other modules.
- Inside a module, import siblings by relative path. Never import your own `index.ts`; that is how
  cycles start{{#if TYPESCRIPT}} (fallow reports them){{/if}}.
{{#if MONOREPO}}
- Shared packages expose curated subpath exports — one per module (`<scope>/core/billing`) — listed
  explicitly in `package.json` `exports` and mirrored in tsconfig `paths`. Never a `"./*"` wildcard:
  it bypasses the public-API boundary and resolves differently across bundlers and `tsc`.
{{/if}}
- Browser code imports narrow entries, never a server-capable barrel. One import must not pull in
  a whole package's dependency graph.

## Colocation

- Tests, fixtures, constants, types, and styles live beside the code that uses them. Promote a file
  upward only when a second owner needs it, and then to the lowest common owner.
- A module-level `types.ts` holds only types shared by several files in that module; otherwise a
  type is declared in the file that owns it.

## Breaking up large files

Split on a measured trigger (cognitive complexity > 30, or a function > 60 lines{{#if TYPESCRIPT}};
`fallow health` names them{{/if}}), not on a line count you eyeballed. Extract within the same file first; promote to a sibling file only when the
unit is reused or large enough to stand alone{{#if TYPESCRIPT}}, and name it with a suffix from
[the table](#suffixes){{/if}}.
Don't split a function whose branches share mutable state, and don't extract a wrapper that is
called once and only forwards arguments.
