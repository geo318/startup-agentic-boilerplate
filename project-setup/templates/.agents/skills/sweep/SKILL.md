---
name: sweep
description: Inspect and release this project's session-owned dev servers, watchers, tunnels, and temporary process trees at handoff, or recover resources after an interrupted session. Use when starting app work, finishing a turn, or diagnosing leftover listeners.
---

# Sweep

Use the project's lifecycle CLI; its registry proves ownership and coordinates other threads.
Read [the lifecycle runbook](../../../docs/session-lifecycle.md) for setup, retention, or recovery
failures. Commands run from the project root with `{{RUNTIME}} scripts/session/cli.mjs`.

- At a new thread, read the user's request and relevant memory, then `begin --intent fresh`.
  Use `--intent continue --reason <evidence>` for requested branches, PRs, or unfinished work.
  Reuse a native hook's session/turn IDs; without hooks, keep the IDs returned by begin.
- Use the returned checkout for every following command. Start background services with
  `run --session <id> --turn <turn> --label <service> -- <executable> <args>`.
  The launcher records processes and actual ports. Never substitute a handwritten PID table.
- Before final handoff, run relevant checks, then `finish --session <id> --turn <turn>`.
  Do this even when no files changed or the task is only inspection. Supported native Stop
  hooks provide a second cleanup path. Reacquire with begin on a subsequent turn.
- To inspect/recover: `status --json`, then `sweep`. An empty `.agents/sessions.md` means no
  recorded active resources or unresolved cleanup. Report any remaining failure accurately.
- A pre-existing service belongs to its original owner. Use `borrow --session <id> --label
  <service> --pid <verified-pid>` when useful; finish removes the lease without stopping it.
- Only an explicit request to leave a service running warrants `run ... --retain <seconds>
  --reason <request> -- <command>`. Retention is finite (at most one day); two hours is a
  reasonable preview default. Its row remains visible until expiry or release.

Routine refresh and exact owned-process cleanup are authorized by the project policy. Do not
ask for repeated confirmation. Never clear the generated document by hand, kill by port/name,
adopt another thread's process, or discard Git work to obtain a clean status. An unverifiable
resource remains recorded; diagnose it without broadening termination authority.
