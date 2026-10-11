---
name: design-taste
description: "Plan visual directions, redesigns, design systems, and Stitch screen briefs. Load the Taste Standard reference only for design planning, not routine UI implementation."
---

# Design taste — on-demand visual planning

Use this skill for **visual design exploration**: a new product style, redesign, design system,
landing-page direction, or Google Stitch screen brief. Do **not** load it just to implement an
approved screen, fix a UI bug, or edit a component.

## Before opening the reference

- Inspect the task, existing UI, and approved project design source of truth. For full setups,
  consult `context/ui-tokens.md`, `context/ui-rules.md`, and `context/ui-registry.md` **only
  as relevant**. In lean projects, inspect existing code and user-approved design decisions.
- Prefer established project tokens, component patterns, brand rules, and the user's direction.
  This skill suggests options; it does not replace a project's design system.

## Load on demand

When an actual **visual design plan** is needed, open
[Taste Standard — DESIGN.md](references/DESIGN.md). Read the relevant sections (atmosphere,
palette, typography, components, hero, layout, responsiveness, motion, anti-patterns), not
unrelated docs or skills. Do not prefetch this reference during setup or normal coding.

The source's defaults (creativity 8, density 4, variance 8, motion 6) and its bans are
**proposals, not universal invariants**. Adjust them for the product, screen type, user goals,
existing tokens, accessibility, localization, and performance. In particular, do not force
animated dashboards, asymmetric heroes, or font changes into established interfaces. Honor
reduced-motion preferences and keyboard/touch accessibility.

## Produce a design plan

Provide only the decisions relevant to the requested design:

1. Design goal, audience, existing constraints, and the four calibrated style dials.
2. Visual direction, semantic color and typography proposals, component and layout patterns.
3. Responsive behavior and states (loading, empty, errors), interaction/motion intent, and
   accessibility/performance trade-offs.
4. A small acceptance checklist for applicable viewports (at least 375px, 768px, 1440px).
5. Explicit deviations from the reference, and mapping to canonical project tokens/rules.

For a persistent plan, use `context/plans/<feature>-design.md` (create the directory for a lean
project if needed). Keep proposed values in the plan; **do not overwrite project UI tokens,
components, or code until the direction is accepted**. Hand accepted work to `architect`
when available for implementation planning.

## Source

Project-adapted entrypoint based on Leonxlnx's
[Taste Standard](https://github.com/Leonxlnx/taste-skill/blob/main/skills/stitch-skill/DESIGN.md).
The full reference and its MIT license are vendored under `references/`.
