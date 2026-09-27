---
name: imprint
description: After building a UI component, extract the visual and structural patterns that matter for consistency and record them in the UI registry, so every later component matches. Also audits existing components for drift. Use after building any new UI component, or with "audit" to check consistency.
---

# Imprint

Each component an agent builds is built in isolation, so spacing, color, radius, and states drift.
This skill records what was built so the next component can match it.

- `/imprint` — the component(s) changed in this session.
- `/imprint <path>` — one component.
- `/imprint audit` — compare existing components against the registry and report drift.

## 1. Read before recording

Read the component in full, `context/ui-tokens.md`, `context/ui-rules.md`, and the registry
entries for similar components in `context/ui-registry.md`.

## 2. Extract what matters for consistency

Only patterns another component should repeat:

- **Structure** — composition (compound parts, slots), where state lives, the `*-model.ts` split.
- **Layout** — container width, padding, gaps, alignment, responsive breakpoints.
- **Visual** — tokens used for surface, border, radius, shadow, typography roles. Flag any raw
  value that should be a token.
- **States** — hover, focus-visible, active, disabled, loading (placeholder sizing), empty, error.
- **Motion** — durations, easings, reduced-motion handling.
- **Accessibility** — roles, labels, keyboard behaviour, focus management.

Skip anything that is the component's unique content.

## 3. Record

- If an entry for this pattern exists in `context/ui/`, update it; never create a duplicate.
- Otherwise write `context/ui/<kebab-component>.md`:

```markdown
# <Component>

Source: `<path>` · Recorded: YYYY-MM-DD

## Use when
<one or two sentences>

## Structure
## Layout
## Visual
## States
## Motion
## Accessibility

## Do not
<mistakes this pattern avoids>
```

- Add or update the index entry under the marker line in `context/ui-registry.md`: a `###`
  heading, one line "Read [<Component>](ui/<file>.md) when working on this area.", and one or two
  lines on what distinguishes it.

## Audit mode

For each registry entry, compare the listed source and its siblings against the recorded
patterns. Report drift as `file:line — expected — found`, grouped by component. Change nothing
unless asked.
