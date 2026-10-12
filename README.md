<div align="center">

# 🤖 Agentic Boilerplate

**Turn a product plan into a repo that coding agents can actually build in.**

[![npm](https://img.shields.io/npm/v/@geo318/agentic-boilerplate?color=cb3837&logo=npm)](https://www.npmjs.com/package/@geo318/agentic-boilerplate)
[![CI](https://github.com/geo318/startup-agentic-boilerplate/actions/workflows/ci.yml/badge.svg)](https://github.com/geo318/startup-agentic-boilerplate/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)
![works with](https://img.shields.io/badge/works%20with-Claude%20Code%20·%20Codex%20·%20any%20agent-6b4fbb)

[Quick start](#-quick-start) · [What you get](#-what-you-get) · [Staying up to date](#-staying-up-to-date) · [Release notes](CHANGELOG.md)

</div>

---

## Why

Coding agents are fast, but in a bare repo they work blind:

- 🧠 **They forget everything.** Every session starts from zero, and you re-explain the product, the stack and the rules.
- 🧭 **They guess.** Where does this code go? Which library do we use? They don't know, so each session invents its own answer.
- ✅ **They say "done" without proof.** Nothing checks that tests ran, the docs still match the code, or the architecture held.
- 📉 **Docs rot.** Whatever context you wrote goes stale the moment the code moves, and the agent trusts it anyway.
- 🔁 **Every project starts from scratch.** You rebuild the same rules, hooks and CI by hand, a little differently each time.

## What it does

One skill, `project-setup`, reads your plan and sets up the repo so any agent knows **what the product is, where things go, what's next, and how to prove its work.**

| Problem | What the setup gives you |
| --- | --- |
| Agents forget | `AGENTS.md` plus a routed `context/` doc set: the product, glossary, code map and architecture, loaded only when needed |
| Agents guess | Invariants, code standards and a "where do I change X?" map, with scoped rules per app |
| No proof of done | Git hooks, CI with a merge gate, and a stop hook that sends failing checks back to the agent before it hands off |
| Docs rot | `docs-check` fails on dead links, leftover placeholders, oversized docs and undocumented dependencies |
| No plan | A build plan with milestones and a progress tracker that records dated evidence |
| Lost sessions | A `remember` skill that saves and restores a handoff between sessions |
| Same setup every time | One command, one template source, and **sync** to roll improvements into every project |

Structure is rendered **deterministically** by a script with no dependencies. Only the prose that needs judgement is written by the agent, from your plan, and the checks fail until it's all filled in.

## 🚀 Quick start

```bash
npm i -D @geo318/agentic-boilerplate   # pin it in your project
npx agentic-boilerplate install .      # add the skill to .agents/skills (+ .claude/skills link)
```

Then hand the agent your plan:

```text
/project-setup ./plan.md        # Claude Code
$project-setup ./plan.md        # Codex
```

The agent reads the plan and asks only what it can't infer (preset, tenancy, code skeleton, forge). It shows one summary to confirm, then renders and fills everything, runs the checks, and hands off with your first `/architect` task.

> Want it in every project? `npx @geo318/agentic-boilerplate install --global`

## 📦 What you get

| Area | Files | What it's for |
| --- | --- | --- |
| **Agent rules** | `AGENTS.md`, `CLAUDE.md`, `apps/*/AGENTS.md` | Root rules plus a dev loop and scoped rules per app |
| **Project context** | `context/project-overview.md`, `glossary.md`, `code-map.md` | What it is, the vocabulary, and where code lives |
| **Architecture** | `context/architecture/*` | Domain modules, deployment, tenant isolation, auth, AI |
| **Standards** | `context/standards/*` | Design principles, code organisation, React, TypeScript, testing, delivery, database |
| **UI** | `ui-rules.md`, `ui-tokens.md`, `ui-registry.md`, `design-taste` skill | Visual rules and on-demand design guidance |
| **Planning** | `build-plan.md`, `progress-tracker.md`, `decisions/` | Milestones, dated progress, ADRs |
| **Skills** | `architect`, `review`, `recover`, `remember`, `imprint`, `add-library-skill` | Repeatable agent workflows |
| **Checks** | `scripts/checks/docs-check.mjs`, agent stop hook | Docs stay true; failures go back to the agent |
| **Git & CI** | `.githooks/`, `ci.yml`, `merge-gate.yml`, PR template, Dependabot | Branch, commit and PR rules, enforced |
| **Code quality** | `biome.json`, strict `tsconfig`, `.fallowrc.json`, oxlint | Boundaries, dead code, duplication, complexity |

Files are gated by flags (UI, Next.js, DB, auth, multi-tenant, AI, jobs, GitHub, TypeScript), so a backend-only or non-TypeScript project gets only what applies.

### Lean or full

| | **Full** (default) | **Lean** (`flags.LEAN: true`) |
| --- | --- | --- |
| Commands, invariants, code map, plan, tracker, library docs | ✅ | ✅ |
| Hooks and CI | ✅ | ✅ |
| Architecture and standards docs | ✅ | — |
| Workflow skills | all | `remember` only |
| fallow config | ✅ | — |

## 🏗️ Existing projects

The same command works in a repo that already has code. It inventories the repo first (package manager, apps, frameworks, linter, hooks, CI, agent docs) and **fits around it** instead of reshaping it:

- Your linter, hooks and CI stay; the new checks are added alongside them.
- Gates judge **only new code**, so existing debt never blocks you.
- Existing `AGENTS.md`, `CLAUDE.md` and `.claude/settings.json` are merged, never overwritten.
- `context/plans/adoption.md` records the debt you started with and optional moves toward the defaults.

## 🔄 Staying up to date

Templates improve over time. Pull the improvements into any project:

```bash
npm update @geo318/agentic-boilerplate
npx agentic-boilerplate sync --dry-run   # preview
npx agentic-boilerplate sync             # apply
```

| File state | What sync does |
| --- | --- |
| You never edited it | Updated |
| Only you changed it | Left alone |
| You **and** the template changed it | Staged in `.project-setup/sync/` for you or your agent to merge |
| Missing | Created |

Changes are listed in the [release notes](CHANGELOG.md).

## 🤝 Works with

**Claude Code**, **Codex**, or any agent that can read Markdown and run shell commands. `.agents/skills/` is the canonical location, and Claude gets symlinks in `.claude/skills/`. Requires **Node 22+** (or Bun) and Git.

---

<details>
<summary><b>Maintaining this repo</b></summary>

```text
project-setup/
  SKILL.md              the workflow the agent follows
  references/           intake schema, stack presets, invariants, skills catalog, adopt recipes
  templates/            the output tree ({{VAR}}, {{#if FLAG}}, {{#each APPS}}, FILL markers)
  scripts/scaffold.mjs  deterministic renderer + lock file + --sync
  scripts/detect.mjs    read-only inventory of an existing repo
bin/cli.mjs             npm CLI: install, sync
install.sh              install from a clone (--link for live edits)
```

- **Test:** `node --test 'test/*.test.mjs'`
- **Try a template change:** `node project-setup/scripts/scaffold.mjs --answers a.json --target /tmp/x`, then `node /tmp/x/scripts/checks/docs-check.mjs --root /tmp/x`
- **Token audit:** `node project-setup/scripts/token-audit.mjs --target <repo> --harness claude|codex|all`
- **Release:** add a `CHANGELOG.md` entry, then `npm version patch && git push --follow-tags`. CI tests and publishes the tag.
- **Install from a clone:** `./install.sh --global --link`, so edits here apply immediately.

The skill can report setup bugs it hits back upstream (`auto`, `ask` or `off`, default `ask`), using synthetic examples with project data redacted. See [upstream reporting](project-setup/references/upstream-reporting.md).

</details>
