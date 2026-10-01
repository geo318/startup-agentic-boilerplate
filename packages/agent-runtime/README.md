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

## Trust model

- A task runs on a **copy** of the project. Nothing touches your tree; `export` gives a patch you apply yourself. No commit, push, merge, or deploy.
- Models only return JSON actions. The controller performs and logs every effect; gates run by id from `policy.json`.
- **Operator decisions** (isolation choice, plan approval, acceptance, owner-declared qualification) need a person at an interactive terminal. Flags and env vars cannot grant them.
- Hosted providers (Claude CLI, manual, hosted chat endpoints) are blocked unless `policy.egress` is `hosted-allowed`.
- Isolation is your choice per task: Docker (throwaway container, no network) or none (host, your permissions; refused for R3).
- R2/R3 need an approved plan before code and an independent review before acceptance. The risk tier is recomputed from the actual diff.

## Status

Verified: controller, resume/cancel, schemas, CLI, trusted base-branch CI verifier, adversarial suite, eval harness with independent graders.
Live evidence (development set `dev-r1`, 8 synthetic cases, **n=1 per case per arm**, tuned against, so optimistic; not a holdout):
see [docs/evaluation.md](../../docs/evaluation.md) and `evals/baselines/` (pre-fix and post-fix runs are both kept).
One real-project pilot (family-tracker, scratch clone, Claude Haiku): one accepted-and-independently-verified task, one refused R3 change.
**Not verified:** a real Docker container run, Ollama or Codex, typechecking (`@types/node` not installed), holdout/regression suites, anything about success rates beyond these small samples.
Jev: optional, off by default, shadow evidence only ([docs/jev.md](../../docs/jev.md)).
Learning: lifecycle built and tested; the first live evaluation passed a harmful lesson through a noisy single-baseline design, which is fixed but not yet re-run live ([docs/learning.md](../../docs/learning.md)).
Not built: TypeScript-parser architecture analysis, model-drafted proposals.
