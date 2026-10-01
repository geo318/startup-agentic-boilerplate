---
name: review
description: After building a feature, verify it matches what was planned, respects the architecture and standards, handles failure and edge cases, and is ready to ship. Reports findings by severity and fixes nothing unless asked. Use after a feature, before a demo, or when something feels off.
---

# Review

Building is done when the code is correct, not when it runs. This skill reports; the developer
decides what to fix.

## 1. Establish the benchmark

Read the `/architect` plan (conversation or `context/plans/`), the original request, and the
`AGENTS.md` invariants. Then get the diff (`git diff {{DEFAULT_BRANCH}}...HEAD` plus uncommitted
changes) and read every changed file in full, not only the hunks.

## 2. Check, in this order

1. **Plan fidelity** — everything planned exists; nothing unplanned slipped in; agreed terms are
   used in code and UI.
2. **Invariants** — each `AGENTS.md` invariant against the diff. Any violation is critical.
3. **Layering** — every change sits in the layer that owns it; no shortcuts across the request
   path; no old path left connected beside its replacement.
4. **Design** — the owning module holds the logic; business rules sit in `domain/`, not use
   cases, routes, repositories, or UI; no import past another module's entry point, and no `index.ts` importing outside its own
   folder; one
   transaction per command, no network call inside it; files named and placed per code
   organisation; no speculative abstraction, option, or extension point (YAGNI); no duplicated
   rule or schema (DRY of knowledge){{#if HAS_UI}}; every mutation invalidates what it changes,
   and no request waterfall or unmeasured memoization{{/if}}.
5. **Correctness** — input validation at boundaries, error paths, empty/loading/partial states,
   concurrency and double-submit, idempotency of retries, timezone and money handling.
6. **Security** — authorization on every new route *and* row; no secrets in code or logs; no
   untrusted value used as an id, URL, query fragment, or HTML.
7. **Tests** — new behaviour has tests that would fail without it; bug fixes carry a regression
   test; nothing asserts implementation details.
8. **Standards** — `context/code-standards.md` rules, design principles{{#if HAS_UI}}, UI rules and the UI registry{{/if}}, naming, dead code.
9. **Docs** — build plan, progress tracker, and any rule docs updated in the same change; a new
   module has its `context/code-map.md` row, a new dependency its `context/library-docs.md` row
   (`/add-library-skill`); a new rule that a tool can enforce went into the tool's config, with
   a one-line pointer in the docs instead of a paragraph.

Run the verification checks in `AGENTS.md` and read their output. They catch the mechanical
issues (imports, boundaries, dead code, missing doc rows); spend the review on what they cannot.

## 3. Report

```
## Review — <feature>

Verdict: ready | ready after fixes | not ready

### Critical (must fix)
- <file:line> — <what is wrong> — <why it matters>

### Should fix
- …

### Consider
- …

### Checks run
- <command> — <result>
```

Only report findings you verified in the code. If nothing is wrong in a category, omit it. Do not
fix anything unless the developer asks.
{{#if AGENTIC_RUNTIME}}

## Managed mode

When `node scripts/agentic.mjs doctor` passes, R2/R3 tasks get an independent review inside the run:
the reviewer sees the original goal, the changed files and the controller-run check results. Use this
skill for the human-facing review of the exported patch (`task export <id>`).{{/if}}
