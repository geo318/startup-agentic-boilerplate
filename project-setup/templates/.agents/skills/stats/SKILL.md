---
name: stats
description: Report how the managed agentic workflow has been used in this repo (tasks, verified candidates, escalations, tokens, cost, timing). Use when asked how much it was used, how many problems it solved, what it cost, or how fast it is. Reports measured numbers only; never claims savings it did not measure.
---

# Stats

Run the command and report what it prints. Do not estimate, round up, or fill gaps.

```
node scripts/agentic.mjs stats               # this repo
node scripts/agentic.mjs stats --since 30d   # a time window (Nd or an ISO date)
node scripts/agentic.mjs stats --all         # every repo of this user
node scripts/agentic.mjs stats --json        # machine-readable
```

## How to read it

- **Verified candidate** = a change whose gates passed on the exact candidate. It is *not* merged or deployed, and only **human-accepted** is a person's yes.
- **Cost per verified candidate** divides the spend of *all* tasks (including ones that stopped or escalated) by verified ones. It is undefined when none verified.
- **Stopped/abstained** (blocked, escalated, needs input) is often the right outcome. Do not present it as failure without the reason (`node scripts/agentic.mjs report <task-id>`).
- **Timing** exists only for tasks run after timestamps were added; the output says how many tasks have it.
- **Savings are not measured.** Never say "saved X tokens/time". Only spend and outcomes are recorded. A saving claim needs a baseline (the same work done without the workflow), for example the comparison runs in the evaluation docs.
- Numbers come from this user's controller folder, so another person's usage of the repo is not included.
