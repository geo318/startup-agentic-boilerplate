# Provider contract

A provider is `{ id, hosted, generate(req) }` ([provider.ts](../packages/agent-runtime/src/provider.ts)).

- `id` is the exact model/profile identity (model, context, endpoint). A qualification belongs to one `id`; change the
  id (model, quantisation, context) and it needs qualifying again.
- `hosted` says whether prompt content leaves the machine. Hosted providers are blocked unless the policy's `egress`
  is `hosted-allowed`. Manual exchange counts as hosted because the controller cannot see where the packet goes.
- `generate` returns `{ content, finishReason, usage, latencyMs, costUsd? }`. Anything but `stop` is never executed.
  `usage: null` means unknown, and the call is charged at its reservation, never as zero.
- `schema` is a request, not a guarantee: output is always re-validated, and a valid shape is not a correct answer.

Adapters: `mock/replay` (tests), `ollama` (native, optional), `claude-cli` (text-only, tools off), `chat-completions`
(any compatible endpoint; schema support declared per profile), `manual` (packet files). Compatible endpoint names do
not imply identical tool, schema, reasoning, cancellation, or usage behaviour: each profile is qualified on its own.
Qualification is per role family (`action-protocol`, `architecture`, `review`); a probe only ever grants the first.
