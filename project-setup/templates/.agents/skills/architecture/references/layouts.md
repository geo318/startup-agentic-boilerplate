# Layout examples

Use these to explain ownership, not as scaffolding to copy wholesale. Adapt names, file casing,
extensions, and framework-reserved directories to the project. Create a directory only when it
has real contents. Keep the module's public entry stable when regrouping its internals.

## Backend

```text
src/
  api/                         presentation / HTTP transport
    billing/
      invoices
      payments
    dependencies
    errors
  billing/
    public-entry               explicit public operations and contracts
    domain/
      pricing/                 cohesive rules when the domain grows
      discounts/
      settlement/
    use-cases/
      issue-invoice
      settle-invoice
    queries/
      invoice-list
    ports                      InvoiceRepository, PaymentGateway
  persistence/
    models/
      billing
    repositories/
      billing/
        invoice-repository     concrete implementation + mapping
    unit-of-work               transaction lifecycle
    composition                transaction-bound repository wiring
  integrations/
    payments/                  gateway implementation
  composition                  application wiring
```

`api/` is the presentation layer even without a `presentation/` wrapper. `use-cases/` and
`domain/` cover BLL responsibilities; `persistence/repositories/` is the DAL. Existing names
such as `db/`, `application/`, `services/`, or module-owned `infrastructure/` can express the
same boundaries. Preserve them when they make ownership clear. Small modules can start with
one domain file, a port, and an operation; extra groups become useful as responsibilities grow.

## Web

```text
src/
  app/workspace/[workspaceId]/  framework routes compose features
  features/
    billing/
      public-entry
      invoices/                subfeature owns its data lifecycle
        api
        queries
        hooks                  or framework loaders
        components/
          invoice-list
          invoice-editor/
            invoice-editor
            invoice-editor-model
            line-items
      payments/
        components/
  components/ui/               reusable primitives
```

Source ownership follows the product and component hierarchy, not every URL segment or every
DOM node. A component only used by the invoice editor stays there; a billing-wide contract stays
at the billing root. Share across features through a deliberate common owner or public API.

When using dedicated tests, mirror that ownership: `tests/features/billing/invoices/` for UI
tests and `tests/billing/domain/pricing/` for backend rules. Preserve the runner's unit and
integration separation, discovery patterns, and fixture loading. Otherwise keep the project's
existing colocation convention.
