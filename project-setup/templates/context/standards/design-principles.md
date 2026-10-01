# Design principles

The principles this codebase follows, stated as what they mean here and the misuse each one
invites. `/architect` plans against this file; `/review` checks diffs against it. When two
principles pull in different directions, [the tie-breakers](#when-principles-conflict) decide.

## SOLID

| Principle | Here it means | Misuse to avoid |
| --- | --- | --- |
| Single responsibility | One reason to change per unit: a route does transport, a use case runs one operation, a domain function decides one rule, a repository persists one aggregate, a component renders one thing. | Splitting a cohesive 40-line function across five files. |
| Open/closed | Extend by adding: a new use-case file, a new adapter behind an existing port, a new union variant handled by an exhaustive `switch` that fails to compile until every case is covered. | Plugin registries and strategy maps for variants that do not exist yet. |
| Liskov substitution | Every adapter, including the test fake, honours the whole port contract: same errors, same empty and null results, same ordering. | A fake that never throws the error the real adapter throws. |
| Interface segregation | Ports list only the methods their use cases call; a use case's deps type names only what it uses; a component takes only the props it renders. | One god-`Repository` per module; passing a whole entity to render its name. |
| Dependency inversion | Domain and use cases depend on ports they declare; database and vendor adapters depend on the domain; the composition root wires them. See [domain modules](../architecture/domain-modules.md). | Core importing the ORM, a framework, or a vendor SDK. |

## DRY

- DRY is about knowledge, not text. Each business rule, schema, constant, and type has one
  authoritative home, and everything else refers to it. Two identical lines that encode different
  rules are not duplication; keep them apart.
- Contracts are declared once: one schema per request and response, used by both the client DAL
  and the route. Types are inferred from the schema, never hand-written twins.
- Rule of three: accept the second copy; extract on the third, into the lowest common owner (the
  feature, then the module, then shared). Never into a `utils/` dump.
- Duplication across module boundaries is often correct. Two modules that each hold a `Customer`
  shape own different views of it; sharing one type couples their release cycles.
- The wrong abstraction costs more than duplication. When a shared helper gains a flag or a
  parameter per caller, inline it back into its callers.

## YAGNI

- Build what the current milestone in the [build plan](../build-plan.md) needs. No options,
  generic parameters, config flags, hooks, or extension points for requirements that are not in
  it.
- An interface with one implementation is justified only at an I/O boundary (a port), where it
  pays for itself in tests. Nowhere else.
- No speculative structure: no empty folders, no `v2` beside `v1`, no "future" columns or enum
  values.
- Deleting is progress. Remove dead code, unused exports, and feature flags whose rollout has
  finished in the change that makes them dead.

## KISS

- Use the platform and the framework's default path before building infrastructure. No custom
  router, event bus, DI container, cache layer, or state machine library without a measured need
  recorded in a decision.
- Plain functions and data over classes; composition over inheritance. Inheritance is limited to
  error classes.
- Explicit over clever: no metaprogramming, proxies, string-built imports, or decorators carrying
  business logic.
- Early returns over nesting; one level of abstraction per function.

## Supporting rules

- **Functional core, imperative shell.** Decisions are pure functions; I/O happens at the edges
  (use cases, adapters, handlers). Pure code is tested without mocks.
- **Parse, don't validate.** Parse untrusted input once at the boundary into a typed value; inner
  code trusts types instead of re-checking.
- **Command-query separation.** A function either changes state or returns data. A command may
  return what it created.
- **Tell, don't ask.** Call the domain function that owns a rule (`markPaid(invoice)`) instead of
  reading an entity's internals to decide in the caller.
- **Least surprise.** Names come from the glossary. A function does what its name says and nothing
  else: no hidden writes in a `get…`, no network call in a `format…`.

## When principles conflict

1. Invariants, security, and correctness beat every principle here.
2. Boundaries beat convenience. Dependency direction and module entry points hold even when a
   shortcut is shorter.
3. Readability for the next reader beats reuse. Inside a module, KISS and YAGNI beat DRY and
   open/closed.
4. Measure before optimising. Performance work needs a number before and after.
