# AI architecture

<!-- FILL: which AI features the product has (from the brief), which model providers, and where AI code lives (one directory owns every implementation). -->

## Rules

- **One structured-output runner.** Every task that needs structured data goes through a single
  runner that injects the schema, calls an injected `generate` function, validates with the schema,
  and feeds validation errors back as a repair prompt for a bounded number of retries. Never parse
  free-form model text by hand. Runner location: <!-- FILL: path, or "(planned)" -->.
- **Providers are injected.** Business code receives a `generate`/model port; it does not import
  provider SDKs. Swapping or falling back between providers happens in one gateway.
- **Model output is untrusted input.** It never supplies tenant ids, user ids, prices, or
  permissions. Tools re-derive those from the actor context.
- **Mutations need exact approval.** An AI-proposed write is shown to a person as the exact change,
  approved, then re-validated against current domain state before it runs.
- **Budgets are enforced centrally.** Rate limits and per-tenant/per-plan usage caps live in the
  gateway, not in each feature.
- **Every prompt/model change has an eval.** Keep a small scenario set per task and run it before
  changing prompts, models, or tools.
- Log each call with task name, model, latency, token usage, and outcome; never log secrets or
  raw personal data.
