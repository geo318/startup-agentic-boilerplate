# Domain modules

How business logic is organised: modules (bounded contexts), what goes inside one, how modules
talk to each other, and how a use case reaches the database. Read before adding a module, use
case, entity, port, repository, or adapter.

<!-- FILL: one sentence naming this repo's paths — the module root (e.g. `packages/core/src/<module>/`), the repository root (e.g. `packages/db/src/repositories/<module>/`), the adapters root, and the composition root(s) (e.g. `apps/api/src/composition.ts`). The rest of this file uses `<module>/`, `<db>/`, and "composition root" for them. -->

## Vocabulary

| Term | Here |
| --- | --- |
| Module | One bounded context: a product area with its own language, rules, and data (`billing`, `scheduling`). One row in the [code map](../code-map.md). |
| Entity | A domain object with identity and a lifecycle (`Invoice`). |
| Value object | An immutable value defined by its fields and validated on creation (`Money`, `EmailAddress`). |
| Aggregate | An entity plus what must change with it atomically (`Invoice` + its lines). The unit of consistency. |
| Use case | One application operation: a *command* changes state, a *query* reads. The request path's "service". |
| Port | An interface a module declares for something it needs from outside (persistence, clock, payments). |
| Adapter | An implementation of a port: a repository, a vendor client, a fake in tests. |
| Domain event | A past-tense fact another module may react to (`InvoicePaid`). |

The ubiquitous language is [the glossary](../glossary.md). Module, entity, use-case, and event
names use its terms exactly; a new domain word goes into the glossary before it goes into code.

## Modules

- One module per product area. Split a module only when its parts use different language or change
  for different reasons; merge two that always change together.
- A module owns its tables. No other module reads or writes them — not with SQL, not through the
  owner's repository. It calls the owner's public API or reacts to its events.
- A module's public API is its `index.ts`: explicit named exports of use cases, queries, public
  types, errors, and events. Everything else is internal. Importing past another module's
  `index.ts` fails the architecture contract test.
- Dependencies between modules point one way and never form a cycle. Two modules that need each
  other → one reacts to the other's events, or the shared concept moves to the one that owns it.
- The shared kernel (`shared/` beside the modules) holds only stable cross-cutting pieces:
  `DomainError`, branded id helpers, `Money`, and the clock, id, and unit-of-work ports. A module
  concept does not move there because a second module wants it.

## Module anatomy

```
<module>/
  index.ts                  public API — explicit named exports, no `export *`
  domain/
    <entity>.ts             entity type + pure functions that create and transition it
    <value-object>.ts       value objects: parse/create, validate, compare
    events.ts               events this module publishes
  errors.ts                 typed domain errors (extend DomainError, stable `code`)
  ports.ts                  interfaces this module needs: repositories, gateways
  use-cases/<verb>-<noun>.ts  one command per file: `void-invoice.ts`
  queries/<noun>-<view>.ts  reads shaped for a screen or endpoint
  handlers/on-<event>.ts    reactions to other modules' events
```

Create a folder when its first file exists. A new module usually starts as `index.ts`,
`domain/<entity>.ts`, `ports.ts`, and one use case. Tests sit beside the file they test.

## Domain model

- Business rules live in `domain/` as pure functions: no I/O, no framework, ORM, or vendor imports,
  no clock reads (take `now` as an argument). They take and return values and throw typed domain
  errors. This is the most tested code in the repo and needs no mocks.
- Entities are readonly data types plus the functions in the same file that create and transition
  them (`createInvoice`, `markPaid`, `voidInvoice`). Classes are allowed but not required; never
  ORM-decorated.
- Make illegal states unrepresentable: discriminated unions for lifecycles
  (`{ status: "draft" } | { status: "paid"; paidAt: Date }`), branded ids (`InvoiceId`), value
  objects for anything with rules.
- One command changes one aggregate. Reference other aggregates by id, never by holding their
  object. Load and save a whole aggregate through its repository; its child entities have no
  repository of their own. A command that must change two aggregates atomically needs a written
  reason in its `/architect` plan; otherwise the second change reacts to an event.

## Use cases

A use case reads like a recipe: load, decide (domain function), persist, emit. It holds no
business rule itself. Dependencies are explicit parameters: a factory takes the ports, and the
result is the operation. No DI container, no service locator, no module-level singletons.

{{#if TYPESCRIPT}}
```ts
// <module>/use-cases/void-invoice.ts
export interface VoidInvoiceDeps {
  uow: UnitOfWork<{ invoices: InvoiceRepository; outbox: OutboxWriter }>;
  clock: Clock;
}

export function makeVoidInvoice({ uow, clock }: VoidInvoiceDeps) {
  return (actor: Actor, input: VoidInvoiceInput): Promise<Invoice> =>
    uow.run(async ({ invoices, outbox }) => {
      const invoice = await invoices.findById(input.invoiceId);
      if (!invoice) {
        throw new InvoiceNotFoundError(input.invoiceId);
      }
      assertCan(actor, "void", invoice);
      const voided = voidInvoice(invoice, clock.now());
      await invoices.save(voided);
      await outbox.add(invoiceVoided(voided));
      return voided;
    });
}
```

{{/if}}
- A deps type names only the ports that use case calls, so each use case is testable with small
  fakes and its reach is visible in its signature.
- Input arrives already parsed by the transport layer; the use case trusts its types.
{{#if HAS_AUTH}}
- Authorization of the loaded row happens here, through the permissions module
  ([authorization](authorization.md)), not in the repository.
{{/if}}
{{#if MULTI_TENANT}}
- Tenant-owned repository methods take the tenant id from `actor`, never from `input`
  ([tenant isolation](tenant-isolation.md)).
{{/if}}
- Queries skip the aggregate: they read through a read port shaped for the caller (selected
  columns, paginated) and return DTOs. They are still authorized and still ORM-free.

{{#if HAS_DB}}
## Transactions (unit of work)

The transaction boundary of a command is its use case: exactly one `uow.run(...)` per command.
Routes, repositories, and domain functions never open, commit, or roll back a transaction.

{{#if TYPESCRIPT}}
```ts
// shared kernel (port)
export interface UnitOfWork<Repos> {
  run<T>(work: (repos: Repos) => Promise<T>): Promise<T>;
}

// <db>/unit-of-work.ts (adapter)
export function createUnitOfWork(db: Database): UnitOfWork<Repositories> {
  return { run: (work) => db.transaction((tx) => work(createRepositories(tx))) };
}

// <db>/repositories/index.ts — every repository is bound to an executor: the client or a transaction
export function createRepositories(executor: Executor): Repositories {
  return { invoices: createInvoiceRepository(executor), outbox: createOutboxWriter(executor) };
}
```

`Executor` is the ORM's "client or open transaction" type, so one repository implementation runs
inside or outside a transaction. The composition root passes the full `UnitOfWork<Repositories>`;
each use case's narrower `UnitOfWork<{…}>` accepts it structurally.

{{/if}}
- Inside `uow.run`, use only the repositories the callback receives. A repository captured from
  outside silently escapes the transaction.
- No network calls inside `uow.run` (vendor APIs, email, AI, HTTP). Call before and pass the
  result in, or after, through the outbox.
- A state change and the events it causes commit together: the use case writes the event to the
  outbox inside the same `uow.run`, and a dispatcher delivers it afterwards. Handlers are
  idempotent because delivery is at-least-once.
- Queries do not need a unit of work; they receive a read port bound to the client.

{{/if}}
## Ports and adapters

- The module that needs a port declares it in its own `ports.ts`. Cross-cutting ports (clock, ids,
  unit of work) live in the shared kernel.
- Name ports for their role, not their technology: `InvoiceRepository`, `PaymentGateway`,
  `Mailer`, never `DrizzleInvoices` or `StripeClient`.
- A port lists only the methods a use case calls today. Add a method with the use case that needs
  it.
- Repositories live in `<db>/repositories/<module>/<entity>-repository.ts` as
  `create<Entity>Repository(executor)`. They return domain types, not ORM rows; mapping happens
  inside the repository.
- Vendor adapters translate the vendor's shapes and errors into the module's types and errors
  (anti-corruption layer). A vendor type never crosses into a module.
- Every adapter honours the whole port contract: the same errors, null semantics, and ordering as
  every other implementation, including the test fake.

## Errors

- Each module declares its expected failures in `errors.ts` as subclasses of the shared
  `DomainError` with a stable `code` (`"invoice.already_paid"`).
- Throw them from domain functions and use cases. The transport layer maps codes to responses in
  one place{{#if TYPESCRIPT}} ([errors](../standards/typescript.md#errors)){{/if}}. An expected
  business failure is never a bare `Error`.

## Between modules

- **Synchronous:** import the other module's public API (`index.ts`) when the direction is fixed
  and the call is a query or a command the caller legitimately triggers. When the other module is
  volatile, or the import would create a cycle, declare a port in the caller and adapt the other
  module's API to it in the composition root.
- **Asynchronous:** subscribe to its domain events. The handler lives in the reacting module
  (`handlers/on-invoice-paid.ts`), is idempotent, and re-reads current state instead of trusting
  the event payload for decisions.

## Composition root

The composition root is the only code that knows concrete implementations. It builds the
database client, the unit of work, the adapters, and every use case once per process, and hands
use cases to routes and jobs. Routes and jobs call use cases; they never construct one. Tests
build use cases with fakes the same way.

## Adding a module

1. Name it with a glossary term; add its row to the [code map](../code-map.md).
2. Create `index.ts`, the first entity, `ports.ts`, and the first use case with its unit test.
{{#if MONOREPO}}
3. Add the package subpath export (`<scope>/core/<module>`) and its tsconfig path.
{{/if}}
4. Implement the repository and wire the use case in the composition root.
5. Confirm the architecture contract test passes. It enforces module entry points automatically.
