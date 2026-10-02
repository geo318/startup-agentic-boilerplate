---
name: stats
description: Report managed workflow usage, costs, outcomes and timing. Use when asked for stats or what tasks cost; distinguish recorded usage from unmeasured savings.
---

# Stats

Run the command and report what it prints. Do not estimate, round up, or fill gaps.

```
node scripts/agentic.mjs stats               # this repo
node scripts/agentic.mjs stats --since 30d   # tasks created in this window (Nd or an ISO date)
node scripts/agentic.mjs stats --all         # every repo of this user
node scripts/agentic.mjs stats --json        # machine-readable
```

## How to read it

- **Verified candidate** = a change whose gates passed on the exact candidate. It is *not* merged or deployed, and **operator-accepted** means explicit CLI acceptance, possibly by an authorized agent.
- **Cost per verified candidate** divides the spend of *all* tasks (including ones that stopped or escalated) by verified ones. It is undefined when none verified or billing is incomplete. Unknown token usage retains the reserved estimate; unknown dollars are not treated as free.
- **Stopped/abstained** (blocked, escalated, needs input) is often the right outcome. Do not present it as failure without the reason (`node scripts/agentic.mjs report <task-id>`).
- **Timing:** elapsed time includes approval/idle gaps; task-run execution sums timed controller invocations and excludes gaps between them. Old or incomplete execution timing is `n/a`; report the coverage count. Execution excludes initial copying, standalone qualification and separate approve/accept/verify commands.
- **Savings are not measured.** Never say "saved X tokens/time". Only spend and outcomes are recorded. A saving claim needs a baseline (the same work done without the workflow), for example the comparison runs in the evaluation docs.
- Numbers come from this user's controller folder, so another person's usage of the repo is not included.

- **Scope:** main totals cover managed worker/architect/reviewer calls, not ordinary chats or standalone qualification. Jev usage is separate. Session checks contain no model usage.
- **Date filters:** `--since` includes lifetime usage of tasks created in that window; session checks use their own timestamps. Active lessons show the current release.
- **Storage:** `$AGENTIC_HOME` (default `~/.agentic`), task events under `tasks/<id>/state/events.jsonl`, session checks in `sessions.jsonl`. Use the same user and controller home as the runs.
- **Zero tasks:** check `--all`, the project path and controller home. Setup or Stop-hook checks alone do not create managed model usage.
- **Read errors:** report the named task/path and failed command. Stats refuses incomplete history. Preserve records; do not delete corrupt entries or zero missing billing to produce a cleaner report.
