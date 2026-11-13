# Page-load patterns

Copy the shape, not the names. Each block is the smallest version that held up in production.

## Gates

One module, shared by every deferred widget. The gates are one-way and live for the page's
lifetime, so every subscriber agrees and nothing re-arms on re-render.

```ts
// lib/after-load.ts — imported only by client components
import { useSyncExternalStore } from "react";

/** Runs `callback` after `window.load` and the next idle slot. */
export function afterLoad(callback: () => void) {
  const idle = () => {
    if ("requestIdleCallback" in window) requestIdleCallback(callback, { timeout: 4000 });
    else setTimeout(callback, 1); // Safari has no requestIdleCallback
  };
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
}

const INTERACTION_EVENTS = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"];

/** Runs `callback` after the first interaction, then load + idle. */
export function afterInteraction(callback: () => void) {
  const onInteract = () => {
    for (const type of INTERACTION_EVENTS) removeEventListener(type, onInteract);
    afterLoad(callback);
  };
  for (const type of INTERACTION_EVENTS) addEventListener(type, onInteract, { passive: true });
}

function gate(arm: (open: () => void) => void) {
  let open = false;
  let armed = false;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!armed) {
      armed = true;
      arm(() => {
        open = true;
        for (const notify of listeners) notify();
      });
    }
    return () => void listeners.delete(listener);
  };
  // Server snapshot is false: the gated tree never renders into the HTML.
  return () => useSyncExternalStore(subscribe, () => open, () => false);
}

export const useAfterLoad = gate(afterLoad);
export const useAfterInteraction = gate(afterInteraction);
```

Using it:

```tsx
"use client";
// components/after-load-widgets.tsx — mounted once in the root layout
import dynamic from "next/dynamic";
import { useAfterLoad } from "@/lib/after-load";

// The toast library is only used here, so the whole package leaves the first load.
const WelcomeToast = dynamic(() => import("@/components/welcome-toast"), { ssr: false });

export function AfterLoadWidgets() {
  return useAfterLoad() ? <WelcomeToast /> : null;
}
```

```tsx
// A third-party chat widget: rendered (and its <Script> injected) only after interaction.
// A button that opens the chat is itself an interaction, so it opens the gate too; queue the
// "open" request and replay it in the script's onLoad.
const interacted = useAfterInteraction();
if (!src || !interacted) return null;
return <Script id="chat-embed" src={src} strategy="afterInteractive" onLoad={replayQueuedOpen} />;
```

```ts
// Imperative heavy work (WebGL, a 4 MB model) inside a ref callback or mount handler:
afterInteraction(() => {
  if (signal.aborted) return; // the component may have unmounted meanwhile
  start().catch(showPosterFallback);
});
```

Ad pixels and analytics: render the tag component only when `useAfterLoad()` is true. The tag's
own init sends the first page view, so route changes before load need no special handling.

## Motion gate

Decorative CSS loops are written against `[data-motion-active]`; one client component toggles it.

```tsx
"use client";
export function MotionGate({ selector }: { selector: string }) {
  // Run once on mount (use the project's mount-effect helper).
  useMountEffect(() => {
    const sections = document.querySelectorAll(selector);
    const visible = new Set<Element>();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    let loaded = document.readyState === "complete";
    const canObservePaint =
      "PerformanceObserver" in window && PerformanceObserver.supportedEntryTypes.includes("paint");
    let painted = !canObservePaint;

    const update = () => {
      for (const section of sections) {
        section.toggleAttribute(
          "data-motion-active",
          loaded && painted && !document.hidden && !reduce.matches && visible.has(section),
        );
      }
    };
    // `load` can fire before the first frame; loops must not delay first paint.
    const paint = canObservePaint
      ? new PerformanceObserver((list) => {
          if (list.getEntries().some((e) => e.name === "first-contentful-paint")) {
            painted = true;
            update();
            paint?.disconnect();
          }
        })
      : undefined;
    paint?.observe({ type: "paint", buffered: true });
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? visible.add(e.target) : visible.delete(e.target);
      update();
    });
    for (const section of sections) io.observe(section);
    const onLoad = () => {
      loaded = true;
      update();
    };
    addEventListener("load", onLoad, { once: true });
    document.addEventListener("visibilitychange", update);
    reduce.addEventListener("change", update);
    return () => {
      io.disconnect();
      paint?.disconnect();
      removeEventListener("load", onLoad);
      document.removeEventListener("visibilitychange", update);
      reduce.removeEventListener("change", update);
    };
  });
  return null;
}
```

```css
.below-fold {
  content-visibility: auto;
  contain-intrinsic-size: auto 900px; /* `auto` remembers the real size once rendered */
}
```

## Deferred route prefetch

Warm the one route most visitors go to next, after the current page is done.

```tsx
"use client";
import { useRouter } from "next/navigation";
import { afterLoad } from "@/lib/after-load";

export function DeferredRoutePrefetch({ href }: { href: string }) {
  const router = useRouter();
  // Run once on mount (use the project's mount-effect helper).
  useMountEffect(() => {
    let cancelled = false;
    afterLoad(() => {
      if (!cancelled) router.prefetch(href);
    });
    return () => {
      cancelled = true;
    };
  });
  return null;
}
```

Give the visible link `prefetch={false}` so its viewport prefetch does not race this one.

## Static shell checklist (Cache Components)

| Build error or symptom | Fix |
| --- | --- |
| `Route segment config "runtime"/"dynamic"/"revalidate" is not compatible` | delete it; `"use cache"` + `cacheLife` on the data function; Node runtime for OG images (`readFile` the font) |
| `uncached or runtime data ... outside of <Suspense>` on a `[param]` route | `generateStaticParams`, or `Suspense` around the reader |
| same error from an uncached `fetch` | wrap the loader in `"use cache"` with `cacheTag` + `cacheLife` |
| same error from `searchParams` | static heading/frame in the page, list in an async child inside `Suspense` |
| `unstable value new Date()` | the component that formats it goes in a `"use cache"` scope |
| page-wide hole from a client provider | the provider calls `useSearchParams`; move the read into consumers |
| signed-in users see logged-out header | `await connection()` before the session read |

Build output legend: `○` static, `◐` partial prerender (static shell + holes), `ƒ` per request.

## Bundle guard

Run after `next build` in CI. Browser source maps only in that CI build
(`productionBrowserSourceMaps: process.env.CI_BUNDLE_GUARD === "1"`).

```ts
// scripts/checks/check-web-bundle.ts (sketch)
type RouteStat = { route: string; firstLoadUncompressedJsBytes: number; firstLoadChunkPaths: string[] };

const BUDGETS = [
  // ceiling = measured value + ~10%; write the measurement and its date here
  { label: "landing", route: "/", maxBytes: 1_200_000, maxChunks: 2 },
  { label: "product", route: "/product/[handle]", maxBytes: 1_200_000, maxChunks: 30 },
];
const FORBIDDEN_IN_FIRST_LOAD = [/node_modules\/posthog-js\//, /node_modules\/zod\/v4\/classic\//];

const stats: RouteStat[] = JSON.parse(await readFile(".next/diagnostics/route-bundle-stats.json", "utf8"));
for (const budget of BUDGETS) {
  const route = stats.find((s) => s.route === budget.route);
  if (!route) fail(`${budget.label}: missing route stats`); // fail closed
  if (route.firstLoadUncompressedJsBytes > budget.maxBytes) fail(`${budget.label}: bytes`);
  if (route.firstLoadChunkPaths.length > budget.maxChunks) fail(`${budget.label}: chunks`);
  for (const chunk of route.firstLoadChunkPaths) {
    const sources = await sourcesFromMap(chunk); // follow `//# sourceMappingURL=`; null = fail
    if (!sources) fail(`${budget.label}: missing source map for ${chunk}`);
    if (sources.some((s) => FORBIDDEN_IN_FIRST_LOAD.some((re) => re.test(s)))) fail(`${chunk} leaked`);
  }
}
```

Add a ceiling for each deliberately deferred SDK's async chunk too, so deferred code cannot
grow without anyone noticing. Unit-test the violation finder with fake stats.

## Lighthouse helper

```bash
# median of N mobile runs for one URL
for i in 1 2 3 4 5; do
  npx -y lighthouse@13 "$URL" --quiet --only-categories=performance \
    --output=json --output-path="lh-$LABEL-$i.json" --chrome-flags="--headless=new"
done
# then read categories.performance.score and audits.{first-contentful-paint,
# largest-contentful-paint,total-blocking-time,cumulative-layout-shift,total-byte-weight}.numericValue
```
