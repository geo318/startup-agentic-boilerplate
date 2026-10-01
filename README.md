# Startup agentic boilerplate

## What is this?

It sets up a new (or existing) software project so that AI coding agents can work in it **safely and correctly**.

You give it a plan. It builds the project's rule book and safety checks:

- **Rules for agents** (`AGENTS.md`): what the product is, what must never break, where code goes.
- **Docs the agent reads only when needed** (`context/`): architecture, standards, glossary, build plan, progress.
- **Checks that run by themselves**: lint, docs links, dead code, branch and commit names, CI.
- **Skills** the agent can call: plan a feature, review it, recover when stuck, remember, and more.

It has two parts. You can use the first without the second.

| Part | What it does | Needs |
| --- | --- | --- |
| **1. Setup skill** (`project-setup`) | Writes the rules, docs and checks into your project. | Claude Code, Node 22+ (or Bun). No keys, no model setup. |
| **2. Optional runtime** (`agentic`) | Lets an AI *propose* code while a program *runs the tests and keeps the proof*. The AI cannot say "it works". Only the checks can. | Node 22.18+. A model of your choice. |

## Quick start

```bash
git clone <this repo> && cd startup-agentic-boilerplate
./install.sh --global --link          # for every project, edits here apply at once
# or: ./install.sh ~/apps/my-project  # only inside one project
```

Then, in an empty folder (or an existing repo), in Claude Code:

```
/project-setup ./plan.md
```

Or paste the plan. The skill asks only what it cannot work out, shows **one summary**, waits for your yes, then writes everything,
fills in the blanks from your plan, runs the checks, and ends with your first task.

Already have code? Same command. It looks at your project first and fits itself to it (see "Existing projects").

## Rules for setting up

Follow these. The skill does most of them for you.

1. **Start from a plan** (a file or pasted text). Nothing is invented: unknowns become open questions in `context/build-plan.md`.
2. **Use a clean git state.** Commit or stash first, so you can undo with one command.
3. **Nothing is overwritten.** Files that already exist are skipped and listed, and you merge them by hand. `--force` is only for you, never the agent.
4. **You confirm once.** The skill shows one summary before it writes anything. Say no, and nothing is written.
5. **Preview first** if you run the renderer yourself: add `--dry-run`. It shows what it would create and what conflicts.
6. **Never put secrets in the plan or the answers file.** The answers file is saved at `docs/archive/project-setup.answers.json` and committed. Keys go in the places below.
7. **Fill every `<!-- FILL: … -->` marker.** `node scripts/checks/docs-check.mjs` fails until none are left.
8. **Run the checks before you call it done:** `node scripts/checks/docs-check.mjs`, then the project's lint, typecheck and tests.
9. **Turn on branch protection on GitHub.** The workflow files alone do not stop a merge. Make the checks "required". Check it with `node project-setup/scripts/protection.mjs`. It reports PROTECTED, UNPROTECTED or UNKNOWN. (GitHub's free plan cannot set it on a private repo.)
10. **The runtime is off unless you ask.** Choose it during setup, or later (see "Turn the runtime on or off").
11. **To update later,** run `/project-setup` again. Files you did not edit are updated. Files you edited are left alone. Files changed on both sides go to `.project-setup/sync/` for you to merge.
12. **Setup hits a bug or a confusing rule in this tool?** Report it. See "Found a problem?" below.

## Existing projects

The skill reads your repo first (package manager, apps, linter, hooks, CI, agent docs). Then it adapts:

- Your linter, hooks and CI **stay**. The new checks are added to them.
- Checks judge only **new** code, so old problems never block you.
- `context/plans/adoption.md` lists the old problems and optional clean-ups. Nothing is moved unless you ask.
- Your `AGENTS.md`, `CLAUDE.md` and `.claude/settings.json` are merged, never replaced.

## Working in a project that was set up (daily rules)

- **Branches:** `<type>/<kebab-name>`, for example `feat/add-login`. Types: feat, fix, docs, refactor, perf, test, build, ci, chore, revert.
- **Commits and PR titles:** `type(scope): short summary`, lowercase, at most 72 characters.
- **Never push to the main branch** by default. Use a branch and a PR. Never use `--no-verify`.
- **One worktree per task.** Worktrees live next to the repo in `<repo>.worktrees/<branch-with-dashes>`. One worktree = one branch = one PR.
  `node scripts/git/worktrees.mjs new feat/add-login` makes one. `list` shows them. `clean` removes only the finished ones (merged, pushed, no changes).
  `doctor` finds stale ones. Nothing is ever force-deleted. Full rules: `context/standards/delivery.md#worktrees`.
- **PRs stay `do-not-merge`** until the checks are green and recorded in the PR body.

## The optional runtime (`agentic`)

**The idea:** an AI proposes small changes. A normal program applies them, runs the real tests, and records the proof. A person says yes at the end.
The AI cannot approve its own work.

```bash
node scripts/agentic.mjs doctor                      # is everything ready? (shows ON/OFF, Jev, Docker)
node scripts/agentic.mjs task create task.json       # describe one task
node scripts/agentic.mjs task run <id>               # run it on a COPY of your project
node scripts/agentic.mjs task accept <id>            # you say yes (needs a real terminal)
node scripts/agentic.mjs task export <id>            # get a patch to apply yourself
node scripts/agentic.mjs stats                       # usage, cost, outcomes
```

What it will and will not do:

- It works on a **copy**. Your files are never touched. You get a patch. It never commits, pushes, merges or deploys.
- **You** decide: Docker or not (asked per task), approving a plan, accepting a result. These need a person at a terminal. A flag cannot do it.
- Risky work (login, money, migrations, CI, dependencies) needs an approved plan and a review. If the change touches more than it said, it stops and asks again.
- A task that cannot be done safely **stops and says why**. It does not guess.

### Turn the runtime on or off

- **At setup:** answer yes to the runtime question (`AGENTIC_RUNTIME`).
- **Switch:** `"enabled"` in `.agents/policy.json`. Missing = **on**. `node scripts/agentic.mjs disable` turns it off (needs a terminal). `enable` turns it on.
  When off, tasks and model probes refuse to run.

### Models and keys

- Copy `.agents/models.example.json` to `.agents/models.json` and pick a model (Claude CLI, Ollama, a chat API, or manual copy-paste). **No keys in this file.**
- Hosted models (anything off your machine) only run if `.agents/policy.json` says `"egress": "hosted-allowed"`. Default is `local-only`.
- Each model must pass a small test first: `node scripts/agentic.mjs qualify <profile>`.

### Jev (optional)

- Put your key in `~/.agentic/secrets.env` (one line: `JEV_API_KEY=...`, file mode `600`). It is **per user and outside every repo**. A group-readable file is refused.
- If a key exists, Jev is used automatically for small routing decisions. Today these cannot change a run. Turn off with `"jev": { "auto": false }`.
- It only sends the task goal and file names, never source, and only when `egress` is `hosted-allowed`.
- It is optional. Nothing needs it.

### Where things are stored

- Task history, proof and stats: `~/.agentic/tasks/` (change with `AGENTIC_HOME`). Per user, kept over time, never in the repo.
- `node scripts/agentic.mjs stats [--all] [--since 30d]` shows tasks, verified results, cost and time. It shows **measured** spend only. It does not claim "savings", because that needs a before/after test.

## Found a problem?

If setup (or this tool) is **wrong, broken or inconsistent**, tell this repo. The agent following the skill should do it for you, as you allowed at setup (`auto`, `ask`, or `off`):

| How bad | Example | What happens |
| --- | --- | --- |
| **Important** | Setup crashes. A generated file is broken. A check wrongly passes or fails on a clean project. A secret could be committed. A guard is weaker than the docs say. | A **pull request** with the fix and a test. Never merged by the agent. |
| **Moderate** | Docs and behavior disagree. A rule is unclear or conflicting. A default is wrong but has a workaround. | An **issue**. |
| **Minor** | A typo or wording. | Mentioned in the summary only. |
| **Security hole** | Something an attacker could use. | Tell the owner directly. Nothing public. |

Your project's private details (plan, names, paths, keys) are **never** included. The repo is private, so you need access to open a PR or issue. Without it, the agent writes a
redacted note to `docs/archive/upstream-report-<date>.md` for you to pass on. Full steps: [project-setup/references/upstream-reporting.md](project-setup/references/upstream-reporting.md).

## What a generated project gets

```
AGENTS.md · CLAUDE.md · README.md · .env.example · .gitignore
context/        project overview, glossary, code map, architecture, standards, UI rules, build plan, progress tracker, decisions
docs/           local setup · your plan, unchanged
.agents/        skills (architect, review, recover, remember, imprint, add-library-skill, stats*) · routines · skills index
                policy.json · models.example.json * (runtime only)
.claude/        settings with a Stop hook that runs the checks and sends failures back to the agent
.githooks/ + scripts/git/       branch, commit and PR-title rules · worktrees.mjs
scripts/checks/                 docs-check · (trusted-gates *)
.github/        ci.yml · merge-gate.yml (do-not-merge) · agentic-verify.yml * · PR template · dependabot
biome.json · .fallowrc.json · tsconfig.base.json     TypeScript projects only
                                                      (* only when the runtime is on)
```

Files depend on your choices (UI, Next.js, database, auth, multi-tenant, AI, jobs, GitHub, TypeScript), so a small or non-TypeScript project gets only what applies.

## What is checked, and what is not

**Tested:** the renderer and all setup variants, the install script, the runtime (about 160 tests), type checking, formatting, the architecture check, worktree safety, and real
runs with Claude Haiku (small samples).

**Not tested or not proven:** a real Docker run, Ollama or Codex against a real model, GitHub branch protection on this repo (the free plan cannot set it), success rates beyond small samples, and "savings".
Details and numbers: `docs/evaluation.md`, `docs/jev.md`, `docs/learning.md`, `docs/threat-model.md`.

## This repo

```
project-setup/       the skill: SKILL.md · references/ · templates/ (what gets written) · scripts/ (renderer, detector, protection check)
packages/agent-runtime/   the optional runtime (TypeScript, no runtime dependencies)
schemas/             JSON Schemas for policy, task, model and architecture files
evals/               test cases with hidden graders · baselines/ saved results
docs/                threat model · evaluation · Jev · learning · migration · provider contract
test/                tests for the renderer, installer, variants, launcher, CI check, worktrees
install.sh · biome.json
```

### Working on this repo

```bash
node --test 'test/*.test.mjs'                          # renderer, installer, worktrees, CI check
cd packages/agent-runtime && npm install
npm test && npm run typecheck && npm run format:check
node src/cli/main.ts arch check --project .            # layer rules
```

A rule that proved itself in a real project: add it to `project-setup/templates/` or `project-setup/references/invariants-catalog.md`, with a test.
