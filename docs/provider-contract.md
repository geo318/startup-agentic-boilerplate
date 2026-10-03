# Provider contract

A provider is `{ id, hosted, generate(req) }` ([provider.ts](../packages/agent-runtime/src/provider.ts)).

- `id` is the exact model/profile identity (model, context, endpoint). A qualification belongs to one `id`; change the
  id (model, quantisation, context) and it needs qualifying again.
- `hosted` says whether prompt content leaves the machine. Hosted providers are blocked unless the policy's `egress`
  is `hosted-allowed`. Manual exchange counts as hosted because the controller cannot see where the packet goes.
- `generate` returns `{ content, finishReason, usage, latencyMs, costUsd? }`. Anything but `stop` is never executed.
  `usage: null` means unknown, and the call is retained at its estimated reservation, never as zero. Cost is tracked separately: missing hosted billing is unknown even when tokens are known.
- `maxCostUsd` requests a per-call provider limit when `supportsCostLimit` is true. The evaluation account includes probes and failures and stops further calls after unknown billing. Provider enforcement may overshoot on an in-flight request; reservations do not create an exact billing guarantee.
- `schema` is a request, not a guarantee: output is always re-validated, and a valid shape is not a correct answer.

Adapters: `mock/replay` (tests), `ollama` (native, optional), `claude-cli` (text-only, tools off), `chat-completions`
(any compatible endpoint; schema support declared per profile), `manual` (packet files). Compatible endpoint names do
not imply identical tool, schema, reasoning, cancellation, or usage behaviour: each profile is qualified on its own.
Qualification is per role family (`action-protocol`, `architecture`, `review`); a probe only ever grants the first.

## Selecting models

Model names are configuration values, not vendor detection rules. Set `.agents/models.json` profiles with an explicit
transport (`kind`), model ID and endpoint when applicable. Map `roles.worker`, `workerStrong`, `architect` and `reviewer`
to the profiles you want; they may use different providers. See the [configuration example](../project-setup/templates/.agents/models.example.json).
Handoff works with any user-operated agent; set its label to identify the actual model/settings. The runtime cannot
automatically inherit or verify the model selected in the surrounding chat. Changing models requires fresh qualification;
existing tasks retain their recorded routes, so start a new task for a different profile.

The runtime and live scripts share [one provider factory](../packages/agent-runtime/src/models.ts). `run-eval.ts`,
`learn-eval.ts`, `live.ts` and `live-r2.ts` read `MODELS=/path/to/.agents/models.json` (default `.agents/models.json`) and
`PROFILE=<profile-name>` (default the configured worker). Delegated profiles still require `execution: "delegated"`.
For hosted script calls, set `ALLOW_HOSTED=1`. Construction and validation make no model calls.
File-backed profile paths resolve from the project for `.agents/models.json`, or from the config directory for standalone files.

Dollar-capped evaluations accept local adapters and hosted adapters with provider-enforced per-call cost limits and
billing receipts. Currently the Claude CLI adapter provides that dollar-cap capability; generic hosted chat endpoints and
manual sessions do not. They remain usable in the runtime, but cannot claim to enforce a dollar-capped evaluation.
For native subscription sessions, the [workflow benchmark](../scripts/fp602-benchmark/README.md#native-model-profiles)
uses explicit native-token/time limits and supports both Codex and a command adapter for other CLIs.
