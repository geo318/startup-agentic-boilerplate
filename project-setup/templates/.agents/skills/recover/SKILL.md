---
name: recover
description: When something is still broken after one corrective attempt, stop prompting for fixes and diagnose what kind of failure it is first — then choose a targeted fix, a hard reset, or a rethink. Use when the same problem survives a correction, a fix creates a new bug, or the session is going in circles.
---

# Recover

Not every problem is a bug, and not every bug needs more debugging. Diagnose first, then act —
two separate steps, never swapped.

## 1. Get the facts

Ask for (or collect yourself): what was expected, what happened instead, the exact error/output,
what has been tried, and when it last worked. Reproduce it. If you cannot reproduce it, that is
the first finding.

## 2. Diagnose the failure type

| Type | Signs | Response |
| --- | --- | --- |
| **Local bug** | One clear wrong behaviour; the design is right | Targeted fix + regression test |
| **Wrong assumption** | Code does what was intended; the intent was wrong about a library, API, data, or environment | Verify the assumption against the source (docs, types, the running system), then fix |
| **Environment** | Works elsewhere; stale server/env/cache/build; version mismatch | Restart, clear, reinstall, re-check env — no code change |
| **Context drift** | The session has been patching patches; files contradict each other | Hard reset: stash/revert to the last good state, restate the goal, redo cleanly |
| **Design flaw** | Each fix breaks something else; the plan cannot satisfy the requirement | Stop coding; run `/architect` on the problem |

State the diagnosis and the evidence for it before proposing any change.

## 3. Act

- **Targeted fix:** the smallest change that addresses the diagnosed cause, plus a test that fails
  without it.
- **Hard reset:** show exactly what will be discarded and get confirmation before reverting.
- **Rethink:** summarise what was learned, then hand over to `/architect`.

## 4. Record it

If the cause took real effort to find, add it to `memory.md` (problems solved) and, if it will bite
again, to the relevant doc's gotchas (e.g. `docs/local-setup.md`).

Never retry the same fix with small variations. A repeated failure is a reason to stop and gather
new evidence (a different observation, log, or reproduction), not proof that the hypothesis is
false: change the hypothesis only when new evidence supports it, and escalate when nothing new
can be learned.{{#if AGENTIC_RUNTIME}}

## Managed mode

With the runtime enabled (`node scripts/agentic.mjs doctor` passes), repairs are bounded by the task
budget: one semantic repair, and an identical repeated failure stops the run. Report it with
`node scripts/agentic.mjs report <task-id>` instead of retrying by hand.{{/if}}
