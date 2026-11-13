---
name: page-load
description: Make Next.js pages load fast and keep them fast — static shells with Cache Components, deferring analytics/ads/chat/3D until after load or first interaction, LCP image rules, CSS delivery, prefetch, and CI bundle budgets. Use when a page is slow, Lighthouse/PageSpeed/Web Vitals (LCP, TBT, INP, CLS) regress, when adding a third-party script, widget, heavy animation or SDK to a public page, or when auditing landing/marketing/catalog performance.
---

# Page load

One rule: **nothing competes with the first paint.** The HTML is a cached static shell, the
LCP element is in it and visible without JavaScript, and every byte that is not needed for that
paint arrives later: after `window.load` + an idle slot, after the first interaction, or on intent.

Work the ladder top-down and stop when the page meets its budget. Each rung names the evidence
that justified it; do not keep an optimisation that did not move a measured number.

## 0. Measure before and after

- Measure a **production build** (`next build && next start`, or a preview deploy), never `dev`.
- Lighthouse mobile, at least 3 runs per route (5 before a keep/revert decision); compare
  medians, not the best run. Record score, FCP, LCP, TBT, CLS, total bytes, and HTML size raw
  and gzipped (`curl -s URL | gzip -c | wc -c`).
- Never mix runners: local Lighthouse, hosted PageSpeed and field data differ by tens of points.
  A baseline and its candidate use the same runner, build mode and machine state.
- Localhost cannot show TTFB wins (static shell vs per-request render); confirm those on a
  deployed preview. A lab "no change" on localhost is not evidence against a static shell.
- To compare against the old code, build it in a throwaway `git worktree` on another port.
- Read the report, not just the score: `lcp-breakdown-insight` (load delay vs render delay),
  `bootup-time`, long tasks and `network-requests` name the actual culprit.

## 1. Static shell first (largest win, TTFB and LCP)

Every route must build as `◐` (partial prerender) or `○`. An `ƒ` route renders per request on
every visit; one cookie read in a root layout makes the whole site `ƒ`.

- `cacheComponents: true`. No `dynamic`, `revalidate` or `runtime` segment configs; they are
  incompatible. Data functions opt in with `"use cache"` + explicit `cacheLife` + `cacheTag`.
- Request-time reads (`cookies()`, `headers()`, `searchParams`, `connection()`) happen in the
  deepest component that needs them, inside a `<Suspense>` whose fallback is sized like the
  content. Pass the promise down unawaited (`const cart = getCart()` in the layout, `use(cart)`
  in the leaf) so the layout itself stays static.
- **Session/auth reads call `await connection()` first.** Without it, a build without auth env
  prerenders the logged-out branch and the CDN serves it to signed-in users.
- Catalog and content routes (`/product/[handle]`, `/blog/[slug]`, CMS pages) get
  `generateStaticParams`; unknown params still render on demand.
- Client hooks that read the URL (`useSearchParams`, `usePathname`, `useParams`) suspend during
  prerender. Never call them in a provider at the top of a page: the page above the nearest
  `Suspense` becomes a hole. Keep shared state (optimistic overrides) in the provider; let each
  consumer read the URL inside its own boundary.
- Prerender-time values (`new Date()`, `Math.random()`) inside a `"use cache"` scope (for
  example a cached footer with the copyright year), or computed on the client.
- Webhooks use `revalidateTag(tag, "max")`; Server Actions that must show the user's own write
  use `updateTag(tag)`.
- React batches Suspense reveals (~300 ms). A streamed hole that holds the LCP element costs that
  delay; keep the LCP element in the static part whenever the route allows it.

## 2. Third-party and heavy client code: three tiers

Classify every script, SDK and widget that is not needed for the first paint:

| Tier | When it loads | Examples |
| --- | --- | --- |
| After load | `window.load`, then `requestIdleCallback` (Safari: `setTimeout(fn, 1)`) | analytics, ad pixels, consent banner, toasts, prefetch of the next likely route |
| After interaction | first `pointerdown`/`pointermove`/`keydown`/`scroll`/`touchstart`, then idle | live chat (Tawk, Intercom), WebGL/3D scenes, decorative scroll experiences |
| On intent | click, or hover/focus to preload | chat window runtime, date pickers, editors, markdown renderers, maps |

- Load the code with dynamic `import()` / `next/dynamic` (`ssr: false`) behind the gate, so it
  is not in the first-load chunks. A deferred `<Script strategy="afterInteractive">` still runs
  right after hydration; gate the component that renders it instead.
- Put the gate in **one shared module** (one-way, page-lifetime, `useSyncExternalStore` based):
  see [patterns](references/patterns.md#gates). Do not hand-roll a `useEffect` + timer per widget.
- Interaction-tier work never loads in Lighthouse runs or for visitors who bounce without
  touching the page. It must still degrade gracefully when it arrives late (a poster image
  carries the view until the 3D scene is ready).
- Decide **which** SDK loads per layout, not per pathname or user agent: public layouts get the
  lite analytics build and no session replay. Replay on a public route cost ~7 Lighthouse points
  and +2.4 s LCP in production measurements; UA gating had no effect on Lighthouse.
- Pages whose URL is a credential (unsubscribe, magic links) load no analytics at all.
- Automated browsers (`navigator.webdriver`) get no ad tags.
- Import deep entry points, not barrels, on routes every visitor hits: one barrel pulled a
  113 KB markdown pipeline into a landing page for a launcher that rendered a pill.

## 3. The LCP element

- Exactly **one** preloaded image per route: the LCP candidate (`priority`, or `preload` /
  `loading="eager"` + `fetchPriority="high"` on Next 16+). Never `priority` inside a list or on
  a placeholder: a blur placeholder with `priority` on every grid tile emitted 14 high-priority
  preloads on one product page.
- First row of a product or article grid: `loading="eager"`; first item `fetchPriority="high"`.
  Everything else stays lazy.
- The LCP image is visible in the HTML. A fade-in that starts at `opacity: 0` and waits for
  `onLoad`/hydration holds LCP hostage to the JS bundle; skip the fade for eager images.
- `next/image` with an honest `sizes`; `next/font` for fonts. A font-preload experiment and a
  containment experiment both measured within noise or worse; do not add them without evidence.

## 4. Below the fold and motion

- Below-the-fold sections: `content-visibility: auto; contain-intrinsic-size: auto <px>`. Not
  on anchor targets or sections whose size other code measures.
- Decorative time-based loops run only when all hold: page loaded, first contentful paint seen
  (`load` can fire before the first frame), section in the viewport, tab visible, no
  `prefers-reduced-motion`. Prefer CSS scroll timelines; gate with an attribute toggled by one
  `IntersectionObserver` ([patterns](references/patterns.md#motion-gate)).
- Touch devices get static ambient effects; heavy media is skipped on `Save-Data`.

## 5. CSS delivery

- With Cache Components, keep `experimental.inlineCss` **off**: it repeats the stylesheet in
  every streamed RSC chunk (measured: a home page went 950 KB → 600 KB HTML, 156 → 96 KB gzip,
  when turned off). One cached external sheet is cheaper across navigations.
- Viewport-extracted critical CSS was tried and rejected: ~300 ms better FCP, but early
  interactions (mobile menu opened before the full sheet arrived) rendered broken. Only
  component-owned critical styles that include every open/hover state are acceptable.
- Large apps: one stylesheet per surface (public vs app), each layout imports exactly one, so
  marketing pages do not download dashboard utilities.

## 6. Prefetch

- `partialPrefetching: true`: links prefetch the static shell only, never per-request data.
- Do not use full `prefetch={true}` on dynamic routes: it expanded into repeated abort/retry
  traffic across uncached segments.
- Warm one high-intent route after load + idle with `router.prefetch(href)`
  ([patterns](references/patterns.md#deferred-route-prefetch)), with the link's own viewport
  prefetch disabled.
- Links inside closed menus are still "in the viewport" to `IntersectionObserver`; a
  hidden mega-menu prefetches every target on every page.

## 7. Keep it fast: CI budgets

A regression nobody measures ships. Add a bundle guard after `next build`
([patterns](references/patterns.md#bundle-guard)):

- per guarded route: maximum first-load JS bytes and chunk count, read from
  `.next/diagnostics/route-bundle-stats.json`;
- forbidden modules in first-load chunks (full analytics SDK, schema libraries' classic builds,
  markdown/charting), checked through source maps built only in CI;
- ceilings on known async chunks (analytics SDKs) so deferred code cannot grow unbounded;
- fail closed when stats or source maps are missing.

Set each ceiling from the measured value plus ~5–15 % headroom and write the measurement next
to it.

## Done when

- Build output: every public route `◐`/`○`; no new `ƒ`.
- Before/after medians recorded for each touched route, same runner; no metric regressed
  beyond run-to-run noise, and the change is kept only if something improved.
- Network panel on a cold load: no third-party request before `load`; interaction-tier code
  absent until the first interaction; exactly one high-priority image request.
- Flows still work: URL-driven state (variants, filters, pagination), cart/forms, chat opening
  from its own buttons, reduced motion.
- Rejected experiments and their numbers are written down so nobody retries them blind.
