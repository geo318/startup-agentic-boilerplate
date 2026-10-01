# agent-runtime (optional)

Controlled coding runtime for projects scaffolded by `project-setup`. Documentation mode never needs it.
Node ≥ 22.18, no dependencies (TypeScript runs via Node's type stripping). Pre-release: see the status below.

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
- **Stats:** `agentic stats [--all] [--since 30d] [--json]` summarises your task history for this repo (outcomes, verified candidates, first-attempt, tokens, cost per verified candidate, wall time, Jev, lessons). Measured spend and outcomes only: **savings are not measured** (no baseline). Timing exists for tasks run since timestamps were added. The `stats` skill (installed with the runtime) tells an agent how to run and read it.
- **Jev:** used automatically when `JEV_API_KEY` is in `$AGENTIC_HOME/secrets.env` (default `~/.agentic/secrets.env`, mode 0600, never in a repo) unless the policy sets `jev.auto: false` or its own `jev.modes`. The automatic defaults cannot change a run (route decision acts only once calibrated; skill selection is shadow). Nothing is sent unless the policy's `egress` is `hosted-allowed`; `agentic doctor` says when a key is present but unused for that reason.

## Trust model

- A task runs on a **copy** of the project. Nothing touches your tree; `export` gives a patch you apply yourself. No commit, push, merge, or deploy.
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
**Not verified:** Ollama or Codex, typechecking (`@types/node` not installed), holdout/regression suites, anything about success rates beyond these small samples.
Jev: optional, off by default, shadow evidence only ([docs/jev.md](../../docs/jev.md)).
Learning: lifecycle built and tested; the first live evaluation passed a harmful lesson through a noisy single-baseline design, which is fixed but not yet re-run live ([docs/learning.md](../../docs/learning.md)).
Not built: TypeScript-parser architecture analysis, model-drafted proposals.

## Worker routing (no model call)

With `roles.workerStrong` in `.agents/models.json`, small R1 tasks (≤ 3 contract files) use `roles.worker` (cheap); R2/R3, wider
contracts, and any retry after a failed repair use `workerStrong`. Both profiles must be qualified. The task result lists the
profiles used (`workers`) so outcomes can be compared per route. Without `workerStrong`, behaviour is unchanged.
