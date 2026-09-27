# UI rules

## Component model

- Functional, compositional components. Prefer compound components over deep prop objects.
- Separate logic from presentation: state and effects in hooks (`*-model.ts`), markup in
  components. Render functions are pure and idempotent.
- UI renders state and dispatches intent. It never calls HTTP, the database, or a service directly;
  it calls a feature hook.

## No direct `useEffect`

Never call `useEffect` in a component. For the rare mount-time sync with an external system, use
a named `useMountEffect()` hook.

| Instead of | Use |
| --- | --- |
| Syncing state from props | Derive inline or `useMemo` |
| Fetching data | The data library's query hook / `use()` + Suspense |
| A user-triggered side effect | The event handler |
| Subscribing to an external store | `useSyncExternalStore` |
| DOM setup on mount | A callback ref or `useMountEffect` |
| Resetting state when a prop changes | A `key` |

## Data and forms

- Server data comes from the query library or a server component — never a `useState` + effect
  fetch, never hand-rolled caching or retries. Where state lives, query and cache rules:
  [React](standards/react.md).
- Forms use <!-- FILL: form library + schema resolver, e.g. react-hook-form + Zod --> with the
  schema shared with the server, which parses the same input again.

## Styling

- <!-- FILL: styling system (e.g. Tailwind CSS v4 utilities only; no inline styles or CSS modules). -->
- Never hardcode colors, radii, or spacing that exist as tokens — use [UI tokens](ui-tokens.md).
- Merge conditional classes with one helper (e.g. `cn()`); never import its internals directly.
- Shared primitives live in <!-- FILL: path -->; app-level components in each app.

## Loading states

- A placeholder stands in only for what needs a round trip. Headings, labels, and table column
  headers render from the first paint.
- A placeholder is the size of what replaces it — build it from the real component's markup so
  nothing shifts when data lands. Numbers that change use `tabular-nums`.

## Accessibility

- Every interactive element is keyboard-reachable and uses the semantic element (`button`, not a
  clickable `div`). Icon-only controls carry an `aria-label`.
- Animations respect `prefers-reduced-motion`.

## Pattern registry

After building any new component, run `/imprint` so [the registry](ui-registry.md) records its
patterns. Every later component matches what came before.
