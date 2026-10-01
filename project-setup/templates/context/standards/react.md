# React{{#if NEXTJS}} and Next.js{{/if}}

Where state lives, how data is fetched and cached, {{#if NEXTJS}}server/client rendering, {{/if}}and
performance. Component and styling rules are in [UI rules](../ui-rules.md); feature folder layout is
in [code organisation](code-organisation.md#feature-folders-ui-apps). Framework APIs move fast:
check the installed version's docs{{#if NEXTJS}} (`node_modules/next/dist/docs/`){{/if}} and the
library skill before relying on an API named here.

## Where state lives

Pick the first that fits; never keep the same state in two places.

1. **Derivable** from props or other state → compute it during render.
2. **Shareable or bookmarkable** (filters, tab, page, selected id) → the URL search params.
3. **Server data** → the query library{{#if NEXTJS}} or a Server Component{{/if}}. Never copy it into
   `useState` or a client store.
4. **Form input** → the form library.
5. **Local UI state** → `useState`/`useReducer` in the lowest component that needs it.
6. **Client state shared by distant components** → context for values that rarely change (theme,
   session); an external store with selectors for values that change often. A frequently changing
   context value re-renders every consumer.

## Client data and cache

- Each feature declares its queries once in `queries.ts` as `queryOptions` factories (key, fetcher,
  `staleTime`). Hooks, prefetching, and invalidation all use them; no inline key arrays.
- A query key contains every input its fetcher reads. Keys are hierarchical
  (`["invoices", "list", filters]`) so a mutation can invalidate a whole prefix.
- `staleTime` is chosen per query from how often the data changes. The client default is set once
  in the query client; `0` everywhere causes refetch storms.
- Every mutation states what it changes: invalidate the affected prefixes in `onSettled`, or write
  the returned entity with `setQueryData`. An optimistic update snapshots in `onMutate` and restores
  in `onError`.
- Fetchers pass the query's `signal` to the HTTP client so abandoned requests are cancelled.
- No waterfalls: fetch independent data in parallel (`useQueries`, `useSuspenseQueries`, or one
  route-level prefetch). A child never waits for its parent's render to start a fetch whose inputs
  are already known.
- One query client per request on the server; one per browser tab on the client.

{{#if NEXTJS}}
## Next.js rendering

- Server Components by default. `"use client"` goes on interactive leaves, not on pages or layouts;
  pass server-rendered content into client components as `children`.
- Pass client components only the fields they render, never whole entities or records: everything
  passed is serialized into the page and visible to the user.
- Modules that touch secrets, sessions, or the server DAL import `server-only` and are named
  `*.server.ts`.
- Request-time APIs (`params`, `searchParams`, `cookies()`, `headers()`) are async. Read them in the
  deepest component that needs them so the rest of the route stays static.
- Wrap each independently slow region in `<Suspense>` with a skeleton sized like its content; give a
  segment `error.tsx` when it can fail on its own.
- Server Actions and route handlers are transport, like API routes: parse input with the shared
  schema, authorize, delegate, map errors, then invalidate caches. No business logic.
- `proxy.ts` (formerly `middleware.ts`) does redirects, rewrites, and cheap checks only. It is not
  authorization; every data access still checks on the server.
- Server data rendered on the client: prefetch with the feature's `queryOptions` in the Server
  Component, then pass it through `HydrationBoundary` so the client does not refetch on mount.

## Next.js caching

- With Cache Components, nothing is cached unless it opts in. Cache at the data-function level with
  `"use cache"` in a `*.server.ts` loader, and set `cacheLife` and `cacheTag` explicitly on every
  cached function.
- Tags come from the feature's tag factory in `queries.ts` (`invoiceTags.detail(id)`), so the code
  that writes and the code that reads agree on names.
- A cached function never reads cookies or headers; it receives what it needs as arguments, which
  become part of its key. Data scoped to a user{{#if MULTI_TENANT}} or tenant{{/if}} is cached only
  under a key that includes that id, or not at all.
- The write that changes data invalidates its tags: `updateTag` in a Server Action when the user must
  see their own write immediately; `revalidateTag(tag, profile)` for stale-while-revalidate from
  webhooks and route handlers.
- Public pages (marketing, docs, catalog) are static or cached by default. Authenticated app data
  that another service owns goes through the query library with a short `staleTime`, not through
  the Next cache.

{{/if}}
## Performance

- Measure first: a profiler recording or a Web Vitals number (LCP, INP, CLS) before and after the
  change. Unmeasured optimisation is not a reason to add complexity.
- If the React Compiler is enabled, do not hand-write `useMemo`, `useCallback`, or `memo`. Without
  it, memoize only what the profiler shows is slow, or where a library needs a stable reference.
- Keep updates small: move state down to the component that uses it; lift static content up and
  pass it as `children`; split contexts by how often they change.
- `useTransition` for non-urgent updates (filtering, tab switches); `useDeferredValue` for an
  expensive view derived from typed input.
- Load heavy, below-the-fold, or interaction-only UI (charts, editors, maps) lazily
  ({{#if NEXTJS}}`next/dynamic`{{else}}`React.lazy`{{/if}}). It never ships in a public page's initial bundle.
{{#if NEXTJS}}
- Images use `next/image` with `sizes`; fonts use `next/font`; third-party scripts use `next/script`
  with an explicit strategy.
{{/if}}
- Lists longer than about 100 rows are paginated or virtualized.
- List keys are stable ids, never array indexes for lists that reorder or filter.
