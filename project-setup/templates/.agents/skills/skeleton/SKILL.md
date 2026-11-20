---
name: skeleton
description: Build loading states that are the page itself — real frame, headings, labels and controls from the first paint, bars only where a read fills in a value, each region loading on its own. Use when adding or fixing a loading state, skeleton, shimmer, placeholder or Suspense fallback, when content jumps or pops in after load, or when a placeholder does not match the loaded page.
---

# Skeleton

One rule: **the placeholder is the page with its values missing, not a drawing of the page.**
Everything that does not wait for a read renders for real from the first paint; what waits is a
bar in the exact box its value lands in. When the data arrives, only bars turn into text:
nothing moves, nothing pops in, nothing is replaced.

## 1. Classify every element of the loaded page

Read the loaded component and sort each element before writing any placeholder:

| Element | While its read is pending |
| --- | --- |
| Static: headings, labels, column headers, tabs, descriptions, terms, icons | Render it, real text |
| A value from a read (a name, a figure, a date, a list item) | A bar inside the value's own box |
| A value inside a sentence | An inline bar, the sentence around it real |
| A control filled by a read (a select's options) | The control itself, shimmering in place |
| A part shown only for some users | Decide from a capability already read (section 4) |
| A part whose shape depends on several reads | Hold the region as one island (section 3) |
| A count, status or "empty" message derived from data | Nothing that claims a value: a bar |

Never print a value that is not known yet: "0", "not started", "no items" while the read is
still pending are wrong answers, not placeholders.

## 2. Build it from the real markup

- Reuse the real component's containers and classes; render its static children as they are.
  Export the static parts (field lists, column lists, intro paragraphs) and use them in both.
- When the placeholder must live apart from the page (a shared layout bundle that cannot import
  the feature), both read one frame: shared class constants and pieces in one module.
- Size each bar to its box: an input-height bar for an input, a bar inside a real button for a
  button label, one line-height per text line (`height: 1lh`, so the line matches the
  surrounding font size), the cell's padding for a table cell.
- Tables: real column headers, one bar per column. Lists: each entry in the real entry's box,
  a fixed viewport-sized count, not the page size.
- A real control in a placeholder looks as it will and takes no input: wrap the placeholder's
  controls in an `inert` container, which blocks focus, clicks and label activation alike, and
  keep the region's `role="status"` on an element outside it (inert content leaves the
  accessibility tree). Not `disabled`: its faded look the loaded control does not have; not
  `tabIndex={-1}`, `aria-disabled` or `pointer-events: none`: a click on the control's label
  still reaches it.
- A select whose options are loading shimmers in its own trigger (`aria-busy`); no bar appears
  under it and disappears later.

## 3. Islands, not page swaps

- Each region with its own read owns its pending state. The page frame is never replaced
  because one region is still loading.
- A component nested in a loaded page never renders the whole-page skeleton.
- Parts that land from different reads and would push each other (a header line above a form
  above a document) are held as one island: one placeholder until every read it needs settled,
  then revealed together.
- A component with its own read renders as soon as its frame is known; its read runs alongside
  the others, not after them.
{{#if NEXTJS}}

### In Next.js: islands are Cache Components holes

With `cacheComponents: true` (Partial Prerendering), every route is built into a static shell,
even one that reads request data, and its islands stream into that shell:

- **Build.** Next renders each route until a component makes a request-time read (`cookies()`,
  `headers()`, `searchParams`, `connection()`, an uncached fetch or query). Everything that
  does not wait for one, plus all `"use cache"` output, is the shell; the nearest `<Suspense>`
  fallback is written into the shell in that component's place. A request-time read outside
  any `<Suspense>` fails the build.
- **Request.** The CDN (or Next's own cache when self-hosted) answers at once with the shell:
  frame, static text, bars. The same response stays open while the server renders every hole
  in parallel and streams each one in as it settles, swapping out its fallback. No client
  fetch, no second round trip.
- So one island is one `<Suspense>` around the deepest component that makes the request-time
  read, and its fallback is this skill's placeholder. That placeholder is the first paint every
  visitor gets from the CDN, which is why it must be the page.
- Regions held as one island (above) share one boundary; independent regions get their own,
  so a slow read never holds back a fast one.
- A route-level `loading.tsx` is one boundary around the whole page: the page swap this section
  forbids. Use it only when it renders the page's real frame (section 2's shared frame).
- A value that is the same for every visitor belongs in `"use cache"` (`cacheLife` + `cacheTag`):
  it lands in the shell as text, with no bar at all.
- Dynamic segments: `await params` inside the boundary for one shell shared by every param, or
  list known params in `generateStaticParams` for a shell per param.
- `next build` must show the route as `◐`. An `ƒ` means a request-time read escaped its
  boundary. Configuration rules: [page-load](../page-load/SKILL.md#1-static-shell-first-largest-win-ttfb-and-lcp).
{{/if}}

## 4. Parts only some users see

- Decide from a capability the server already stated and the client already holds (the
  workspace or session read the shell is hydrated with). Never infer it from a role name or
  guess; if no such capability exists, add it to that read.
- Capability true: render the part's placeholder, or the part itself when it has its own read.
  Capability false: render what the loaded page shows instead (the owner-only notice).
- A part that no held read can predict (an eligibility the page's own read computes): make the
  wait rare instead. Prefetch the page's reads on intent (pointer enter and focus on its link,
  loaded lazily so the shell does not grow) and on the server.

## 5. Accessibility and motion

- One `role="status"` with an `aria-label` naming what is loading per region; bars are
  `aria-hidden`; never nest two status regions.
- The shimmer animates only under `prefers-reduced-motion: no-preference`.
- A bar on the page background needs a darker tone than one on a card; check both.

## 6. Verify against the loaded page

A typecheck says nothing here. In the running app:

1. Screenshot the loaded page.
2. Hold its reads and screenshot the loading state at the same scroll position. A temporary
   hold in the browser's fetch client works: wait forever when a `localStorage` regex matches
   the request URL, open the page by client navigation (a hard load may arrive already
   hydrated), and clear the key afterwards. Never commit the hold.
3. Compare: every static text present, every bar where its value lands, the same heights, no
   element that is absent from the loaded page.
4. Release the hold and watch the transition: only bars turn into text.
5. Hold one read at a time for pages with islands, to see each region alone.

## Do not

- Swap the whole page for a skeleton from inside it.
- Draw a shape the loaded UI does not have, or a generic paragraph for a form, a table or a card.
- Put a bar under a control instead of in it.
- Show a guessed capability, or a derived value ("0", "empty") before its read lands.
- Keep a placeholder you have not compared with the loaded page in the running app.

After building or changing a placeholder pattern, run `/imprint` so the UI registry records it.

## Record the project's primitives

Name them once, in the UI registry entry for placeholders (`/imprint`): the bar, text lines one
line-height tall, table rows, list entries, the placeholder-control props, the shimmer, the
selects' pending state, and any frame shared by a page and its route-level placeholder. Reuse
them; add a primitive only when the same shape repeats.
