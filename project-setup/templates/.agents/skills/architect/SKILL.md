---
name: architect
description: Think through a feature like a senior engineer before writing code — map the layers it touches, align on vocabulary, resolve the decisions that change the implementation one at a time, and produce an implementation plan the developer confirms before anything is built. Use before any non-trivial feature, refactor, or cross-layer change.
---

# Architect

A thinking session with the developer, not an interrogation. The output is a plan both of you
agree on, so building can start with confidence.

## 1. Do the homework first

Read, in this order, only what the feature touches:

- the feature request and any linked plan in `context/plans/`;
- `context/build-plan.md` (open questions may already cover this);
- `context/glossary.md`, `context/architecture.md`, `context/code-standards.md`, and the topic
  files their headings route to;
- the existing code on the path the change will use.

Never ask something the docs or code already answer.

### Map the whole path

{{#if REQUEST_PATH_SET}}
Trace the change through every hop of the canonical request path:

`{{REQUEST_PATH}}`

{{/if}}
For each layer the change touches, note what it owns and what it must not do. Also check:

- the owning module, the aggregate each command changes, and whether this needs a new module
  (`context/architecture/domain-modules.md`);
- where each new file goes and what it is called (`context/standards/code-organisation.md`);
- data ownership{{#if MULTI_TENANT}} and tenant scope (where the actor context comes from){{/if}};
- where input/output contracts live and who validates them;
- transaction boundaries, concurrency, idempotency, and retry behaviour;
- expected failures, typed errors, and observability;
- the composition root that wires use cases to adapters, and any new port;
{{#if HAS_UI}}
- where the UI state lives, which queries and caches a mutation invalidates, and any
  performance-sensitive path (`context/standards/react.md`);
{{/if}}
- the simplest design that meets this milestone: no option, abstraction, or extension point the
  build plan does not ask for (`context/standards/design-principles.md`);
- existing paths this replaces, so nothing is left duplicated or still connected.

## 2. Align on language

Pick 3–5 terms from the request that could be read more than one way. State your reading of each
and ask the developer to correct it. Do not continue until they agree. Add agreed terms to
`context/glossary.md` when the plan is confirmed.

## 3. Resolve the decisions that matter

Only decisions whose answer changes what gets built. Highest downstream impact first, one at a time:

```
<The decision>

My thinking: <what I'd do and why>

Does that work for you, or do you see it differently?
```

Skip a decision an earlier answer made irrelevant. Stop when every implementation-changing
decision is settled — not when every question is answered — and say **"Blueprint ready."**

## 4. Write the plan

```
## Implementation plan — <feature>

### What we are building
<one paragraph>

### Language we agreed on
- <term>: <definition>

### Decisions made
- <decision>: <choice and reason>

### Layer map
- <layer>: <responsibility in this feature>

### Modules and files
- Module: <owning module>; aggregate(s) changed: <…>; new ports: <…>
- New files: <path> — <purpose>

### Contracts and failure behaviour
- Input / output: <schema and where it is validated>
- Failures: <typed errors, retries, idempotency, logging>

### Enforcement
- <tests, contract-test rules, or baseline changes this needs>

### Assumptions
- <anything not explicitly confirmed>

### Steps
1. <ordered, each small enough for one commit>
```

Wait for explicit confirmation before building. For work spanning sessions, save the plan as
`context/plans/<feature>.md` and link it from the build plan.

## Stop conditions

Do not approve a plan that breaks an invariant in `AGENTS.md`. In particular:

<!-- FILL: 4–8 bullets derived from this project's invariants, phrased as violations — e.g. "puts business logic or database access in a route", "trusts a tenant id from the client", "lets UI call HTTP directly", "uses a type generic as runtime validation", "leaves the old path connected after its replacement is wired". -->
