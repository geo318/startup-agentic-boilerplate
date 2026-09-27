---
name: remember
description: Save the essential state of a work session to memory.md so the next session continues exactly where this one stopped, or restore that state at the start of a session — keeping the build plan and progress tracker in sync. Use with "save" at the end of a session and "restore" at the start of the next.
---

# Remember

`/remember save` at the end of a session; `/remember restore` at the start of the next. With no
argument, ask which one.

## Never store secrets

API keys, tokens, passwords, cookies, auth headers, connection strings, private keys, webhook
secrets, or anything that looks like one. Write `[REDACTED]` or describe where the value lives
instead. When unsure, leave it out.

## Save

### First, sync the canonical docs

`memory.md` is a handoff note, not the plan. In the same pass:

- work shipped or a milestone completed → `context/progress-tracker.md`;
- priorities, blockers, or open gaps changed → `context/build-plan.md`;
{{#if HAS_UI}}
- new UI patterns → run `/imprint`;
{{/if}}

Never save a memory that says something is done while the build plan still lists it as open. If
the docs disagree on purpose (unmerged branch, external blocker), say so in both places.

### Then write `memory.md` at the repository root

It holds only the latest session. If it exists, show a one-line summary of what it holds and ask
before overwriting.

```markdown
# Memory — <topic>

Last updated: YYYY-MM-DD

## What was built
<files created/changed and what now works, precisely; branch and PR>

## Decisions made
<hard-to-reverse choices and why>

## Problems solved
<issues that took real effort, and the cause, so nobody solves them twice>

## Current state
<what works, what is partial, what is broken; local / merged / deployed / verified>

## Next session starts with
1. <the very next action, specific enough to start immediately>

## Open questions
<unresolved items>
```

Skip anything visible in the code or already in `context/`. Re-read the result for secrets before
writing.

## Restore

Read `memory.md`, then the build-plan and progress-tracker entries it references, and check the
git state (branch, uncommitted changes, open PR). Report in five lines or fewer: where things
stand, what is next, and anything that has drifted since (e.g. the PR merged). Then wait for the
developer.
