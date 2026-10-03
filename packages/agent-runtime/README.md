# agent-runtime (optional)

Optional controlled coding runtime for projects scaffolded by `project-setup`. Direct development is the default; installing the runtime does not enable execution.
Node ≥ 22.18. The controller uses Node built-ins and type stripping; `arch check` additionally needs the installed TypeScript compiler API development dependency. Pre-release: see the status below.

```
agentic doctor
agentic validate [contract.json…]
agentic qualify <profile> [--owner-declare architecture|review|action-protocol]
agentic task start <contract.json> | create <contract.json> | revise <id> <contract.json> | preflight <id> | run <id> | status <id> | approve <id> | accept <id> | cancel <id> | export <id>
agentic report <id>
```

Project files: `.agents/policy.json` (gates, protected paths, egress) and `.agents/models.json` (provider profiles per role).
Schemas: [/schemas](../../schemas). Controller state (tasks, events, qualifications) lives under `$AGENTIC_HOME` (default `~/.agentic`), outside the project.

## Execution mode and model identity

`.agents/models.json` selects `execution: "handoff"` (default for new projects) or `"delegated"`. Handoff uses manual JSON
packets answered by your chosen chat/operator. Delegated execution uses the configured Claude CLI, Ollama or chat API;
your Codex model and reasoning setting do not change those profiles. Legacy external routes now refuse before making a
call until delegation is explicit. Deterministic replay and existing manual-only profiles remain usable.

Models are selected through profiles and role mappings, with no preferred model family. The live/evaluation scripts also read these profiles via `MODELS` and `PROFILE`; see [model selection](../../docs/provider-contract.md#selecting-models).

`doctor` shows routes and qualification sources. `task preflight <id>` checks required routes, qualifications, egress and
unresolved questions without model calls; it displays the initial worker and budget. Each task call also prints its role,
configured provider identity and qualification source, recorded as `model_call` in `state/events.jsonl`. These are configured
identities, not independent provider attestations. Owner-declared qualifications are never described as measured passes.

Existing projects: follow the [one-command routing upgrade](../../docs/migration-guide.md#model-routing-and-pre-edit-budget-upgrade).
It preserves project policy and history and updates the runtime pin; a consumer-only pull cannot update an external runtime.

### Using your current chat

1. Explicitly `enable` managed execution, then run `qualify <worker-profile>` or `task run <id>` in a background/interactive terminal that stays running.
2. Read the printed absolute `packet-<uuid>.json` path. Adapters can discover the exact directory with `agentic handoff-path --project <dir>` (JSON `{ "directory": "..." }`); `doctor` also displays it. CLI execution ignores the legacy profile `dir` and keeps exchanges under `$AGENTIC_HOME/exchange/`, outside the
   candidate tree; the legacy profile `dir` is used only when constructing ManualProvider directly.
3. Have your chosen chat answer the packet's system, prompt and schema. Save only the JSON response to the printed
   `response-<uuid>.txt` path (write a temporary file and rename it atomically). The controller consumes it and may print
   another packet. It applies edits, checks scope and runs gates itself; do not edit the candidate or project directly.
4. For R2/R3, use a separate reviewer context/person for the reviewer packet. Do not call self-review independent.
   Approve the plan and accept verified results through the existing explicit commands when authorized.

There is no automatic Codex invocation, model detection or reasoning-setting override. The current-harness labels describe
who supplies responses; choose the intended model in that chat and requalify when it changes. Plain manual replies leave usage and cost unknown (token reservations are estimates). If the harness exposes native
per-request counters, the operator may write an accounting envelope instead: `{"content":<reply object>,"usage":{"input":120,"output":30},"costUsd":0.02}`.
Cost is optional; missing cost remains unknown. Counters are operator-supplied, not independently attested. Never have the model invent them.
Surrounding chat usage is not measured. Packets expire at the profile timeout
(default 10 minutes), and unique names prevent cross-role/restart reply reuse. Egress consent and qualifications still apply.

## Switch, stats, Jev

- **Switch:** `"enabled"` in `.agents/policy.json` (absent = **off**). `agentic enable` / `agentic disable`. Off = `task run` and probes refuse, nothing model-driven runs. `agentic doctor` shows the state. Automatic full Stop-hook checks additionally require `sessionChecks: true`; explicit `session-check` works while execution is off.
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
| Tokens | Reported input + output usage; when unknown, the budget-accounted total includes reservations and `tokenAccounting` is `includes-estimates`. Token cost per verified result is undefined while any usage is unknown. |
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

For an agreed contract, prefer `task start <contract.json>`: deterministic create → preflight → run in one command.
Supply the agreed `plan` to skip redundant architect generation. This command never approves plans or accepts results;
R2/R3 pause for `task approve <id>`, then continue with `task run <id>`. A failed preflight retains the contract for
inspection/revision but performs no candidate preparation or model calls. Reuse existing profile qualifications;
ordinary tasks do not need fresh qualification probes or a model coordinator to discover/poll CLI commands.

Workers can request `read_many` with 1–20 distinct `paths` in one call. Every path uses the same safety checks as `read`;
a failed batch returns no partial contents. Successful files enter subsequent context with their hashes, including on
resume. Mandatory context is never truncated: an oversized batch stops before the next model call. Repeated-read and
missing-input guards still apply. Prefer declaring known necessary inputs in `files`, avoiding discovery calls entirely.

Workers may use `edit_and_finish` with the same bounded edits array to request verification in one call. Gate failures and
review findings survive routing/resume. Full task gate output is stored under the task's `state/logs/`; prompts receive compact diagnostics.
Before an edit changes the candidate, planning and worker calls share a 3-call limit and a 60% estimated token allowance,
including across normal resumes. Context is checked before installation; planning shares the selected worker context
allowance (4k/8k/16k), with 1,500 output tokens. Include a contract `plan` to avoid another architect call while keeping
R2/R3 operator approval and independent review. Review prompts include complete current files and diffs of the old code.

`task revise <id> <contract.json>` is an explicit operator command, unavailable to workers. It preserves candidate bytes,
installed dependencies, baseline, event history and cumulative token/action/repair counters. Reuse assumes dependencies
and external services stayed unchanged; create a new task if the environment changed. Keep the same ID, goal and
acceptance criteria; adjust context inputs, write scope, plan, or budget. Risk and project policy cannot be weakened.
The new contract is appended to the event log, approvals/evidence become stale, and R2/R3 require a fresh plan approval.
The pre-edit no-progress guard starts a new segment for the revised input; cumulative spending never resets.

New task presets allow one/two/three semantic repairs for narrow/standard/complex. Existing task limits are retained.
If necessary, an operator can supply explicit total `limits` (`aggregateTokens`, `toolActions`, `semanticRepairs`) in the
revised contract; increasing limits authorizes additional work, not a reset. Identical failures still stop. Accepted,
cancelled, unprepared, externally modified, or uncertain-billing candidates cannot be reopened by revision.
Bootstrap and baseline timings and per-call usage/timing are recorded for diagnosing overhead. Token reservations remain
estimates; provider overruns stop further actions. Full chat usage is outside managed task accounting.

Checks may create/update `.next/`, `.turbo/` and `*.tsbuildinfo` outputs without a false source-mutation failure.
Protected paths and existing managed-task tests remain protected, including inside those directories. Workers cannot
edit these output paths directly, and generated output is omitted from review diffs and exported patches. Other generated
source (for example `next-env.d.ts`) still requires an explicit source change or preparation before verification.
Full candidate hashes still include caches: changing any files after verification can invalidate review/acceptance.
Gate-generated changes are recorded so a normal task resume does not mistake them for external edits.

`session-check` reruns by default. `--reuse` reuses only a successful matching source/configuration/branch result. It is an explicit
assertion that dependencies and services did not change, not an automatic environment fingerprint.
