# agent-runtime (optional)

Controlled coding runtime for projects scaffolded by `project-setup`. Documentation mode never needs it.
Node ≥ 22.18. The controller uses Node built-ins and type stripping; `arch check` additionally needs the installed TypeScript compiler API development dependency. Pre-release: see the status below.

```
agentic doctor
agentic validate [contract.json…]
agentic qualify <profile> [--owner-declare architecture|review|action-protocol]
agentic task create <contract.json> | run <id> | status <id> | approve <id> | accept <id> | cancel <id> | export <id>
agentic report <id>
```

Project files: `.agents/policy.json` (gates, protected paths, egress) and `.agents/models.json` (provider profiles per role).
Schemas: [/schemas](../../schemas). Controller state (tasks, events, qualifications) lives under `$AGENTIC_HOME` (default `~/.agentic`), outside the project.

## Switch, stats, Jev

- **Switch:** `"enabled"` in `.agents/policy.json` (absent = **on**). `agentic enable` / `agentic disable`. Off = `task run` and probes refuse, nothing model-driven runs. `agentic doctor` shows the state.
- **Stats:** reports local task usage, outcomes, costs and timing. See [Checking your stats](#checking-your-stats) for commands, coverage and troubleshooting. **Savings require a separate paired benchmark.**
- **Jev:** off unless the project explicitly sets `jev.modes` or `jev.auto: true`. A key alone makes no calls. Auto opt-in enables workflow routing only; shadow skill/retrieval experiments remain explicit and require hosted-egress consent. No net savings have been demonstrated.


## Checking your stats

From the root of a project with the runtime installed, run:

```bash
node scripts/agentic.mjs stats                        # this project's complete task history
node scripts/agentic.mjs stats --since 30d            # tasks created in the last 30 days
node scripts/agentic.mjs stats --since 2026-10-01      # tasks created on/after this UTC date
node scripts/agentic.mjs stats --all --since 30d      # all projects in this controller home
node scripts/agentic.mjs stats --since 30d --json     # machine-readable summary
node scripts/agentic.mjs stats --json > stats.json    # save a local snapshot; check the exit code
node scripts/agentic.mjs task status <task-id>         # inspect one task's recorded state/ledger
```

These commands make no model calls. A report for `--since` includes the **whole lifetime usage of tasks created in that window**, not only calls made during the window. Session checks use their own check timestamps. Active lessons are the current release, not a historical snapshot.

If you only have this runtime checkout, use the direct CLI with the target project's absolute path:

```bash
node packages/agent-runtime/src/cli/main.ts stats --project /absolute/path/to/project --since 30d
```

Use the same user account and `AGENTIC_HOME` that ran the tasks. The default is `~/.agentic`:

```bash
AGENTIC_HOME=/absolute/path/to/controller node scripts/agentic.mjs stats --all
```

### What the numbers mean

| Field | Meaning |
| --- | --- |
| Verified candidates | Tasks currently awaiting acceptance or accepted after the required checks passed. This does not prove general correctness. |
| Operator-accepted | Accepted through the explicit CLI command, potentially by an authorized agent. Not necessarily merged or deployed. |
| Model calls | Recorded attempts by the worker, architect and reviewer, including interrupted attempts. |
| Tokens | Reported input + output usage; when unknown, the reserved estimate remains and the report flags it. |
| Reported hosted cost | Dollars reported for task model calls. Unknown amounts are excluded from the sum and explicitly flagged, never assumed free. |
| Cost per verified candidate | All selected tasks' reported cost, including stopped tasks, divided by verified candidates. Undefined if none verified or any selected task has unknown cost. |
| Elapsed time | First-to-last recorded event (`medianWallMs`, `p90WallMs` in JSON). Includes approval/idle gaps; it is not a live stopwatch. |
| Task-run execution | Sum of timed `task run` invocations (`medianExecutionMs`, `p90ExecutionMs`). Includes model and gate waiting inside those invocations; excludes gaps between them. |
| Recorded session checks | Checks run manually or by the Stop hook. They do not record the surrounding chat's tokens or cost. |

Execution timing covers the controller loop, including baseline checks, models and verification. It excludes initial project copying/provider selection, standalone qualification and separate approve/accept/verify commands. It is available only for tasks with complete timing from their first run; old, currently running or interrupted tasks can show `n/a`. The report gives the number of tasks included in each timing metric. This is not CPU time or a full workflow benchmark.

### Where records live and what is missing

Task metadata and contracts are in `$AGENTIC_HOME/tasks/<id>/`; usage snapshots and UTC timestamps are in `state/events.jsonl`. The controller appends hash-chained events. Stats verifies the chain it reads, but a local hash chain cannot prove that its tail was never deleted or that the entire history was not rewritten. Session checks are in `$AGENTIC_HOME/sessions.jsonl`. Stats stays local and does not mutate these records.

Only **managed task model calls** contribute to the main token/cost totals. Ordinary Codex/Claude chats, standalone qualification costs, local compute costs and human effort are not included. Jev token usage is separate; its dollar costs are not included in task spending. Evaluation runs keep their own account, including qualification, as explained in [the benchmark guide](../../docs/evaluation.md).

### Troubleshooting

- **Zero tasks:** setup alone does not generate usage. Run tasks with `do` or `task run`; check `--all`, your project path, user account and `AGENTIC_HOME`. Stop-hook checks alone can produce session counts with zero tasks.
- **INCOMPLETE / undefined cost:** a provider omitted billing or a call was interrupted. Check provider billing and the identified task history; do not replace missing amounts with zero. Repeated resumes do not count the same interrupted call again.
- **Cannot report complete stats:** malformed metadata, a broken event chain or unreadable session rows stop the command with a nonzero exit and a path. No partial summary is presented as complete. A damaged task anywhere in this controller home can block reporting. Preserve the files and restore from a known-good backup; do not delete history to improve totals. If a writer is still active, retry after it finishes.
- **Runtime changed:** review the upgrade and re-pin it before using the generated launcher; see [migration](../../docs/migration-guide.md).

A lower cost total alone is not evidence of savings: fewer attempted or correctly completed tasks can also lower it. Use the [paired benchmark procedure](../../docs/evaluation.md#paired-workflow-benchmark) to compare the same work and quality.


## Trust model

- A task runs on a **copy** of the project. Worker edits do not target your tree; host-executed checks can access it. `export` gives a patch you apply yourself. No commit, push, merge, or deploy.
- Models only return JSON actions. The controller performs and logs every effect; gates run by id from `policy.json`.
- Approval, acceptance, and owner-declared qualification use explicit CLI commands. An authorized harness can run them without prompts.
- Hosted providers (Claude CLI, manual, hosted chat endpoints) are blocked unless `policy.egress` is `hosted-allowed`.
- Checks run on the host in a separate candidate copy, with a scratch HOME and minimal environment. The copy is not a security sandbox.
- R2/R3 need an approved plan before code and an independent review before acceptance. The risk tier is recomputed from the actual diff.

## Status

Verified: controller, resume/cancel, schemas, CLI, trusted base-branch CI verifier, adversarial suite, eval harness with independent graders.
Live evidence (development set `dev-r1`, 8 synthetic cases, **n=1 per case per arm**, tuned against, so optimistic; not a holdout):
see [docs/evaluation.md](../../docs/evaluation.md) and `evals/baselines/` (pre-fix and post-fix runs are both kept).
One real-project pilot (family-tracker, scratch clone, Claude Haiku): one accepted-and-independently-verified task, one refused R3 change.
**Not verified live:** Ollama or Codex, repeated holdout model trials, or success rates beyond these small samples. Typecheck, parser-based architecture checks and local regression tests run through `npm run verify` at the repo root.
Jev: optional, off by default, shadow evidence only ([docs/jev.md](../../docs/jev.md)).
Learning: lifecycle built and tested; the first live evaluation passed a harmful lesson through a noisy single-baseline design, which is fixed but not yet re-run live ([docs/learning.md](../../docs/learning.md)).
Not built: model-drafted lesson proposals or execution sandboxing.

## Worker routing (no model call)

With `roles.workerStrong` in `.agents/models.json`, small R1 tasks (≤ 3 contract files) use `roles.worker` (cheap); R2/R3, wider
contracts, and repairs after a failed gate or blocking review use `workerStrong`. Both profiles must be qualified. The task result lists the
profiles used (`workers`) so outcomes can be compared per route. Without `workerStrong`, behaviour is unchanged.


## Task scope and verification

`files` names context inputs; `newFiles` explicitly permits missing inputs that will be created. `scope` names allowed writes:
exact paths, or directory prefixes ending in `/`. If omitted, writes are limited to `files` plus `newFiles`.
The controller validates edits and the final diff. Conventional existing tests are frozen by default (`protectExistingTests`);
custom acceptance scripts also belong in policy `protectedPaths`. New development tests may be added within scope.
Changing trusted tests or disabling their protection is a reviewed maintenance operation.

Workers may use `edit_and_finish` with the same bounded edits array to request verification in one call. Gate failures and
review findings survive routing/resume. Full task gate output is stored under the task's `state/logs/`; prompts receive compact diagnostics.
Token reservations are estimates, including schemas, not hard provider limits. Reported overruns stop further actions.
Unknown hosted cost is separate from unknown token usage; incomplete billing has no defined cost-per-verified result.

`session-check` reruns by default. `--reuse` reuses only a successful matching source/configuration/branch result. It is an explicit
assertion that dependencies and services did not change, not an automatic environment fingerprint.
