# Adopting an existing project

## Contents

- [Linting (OWN_LINTER)](#linting-own_linter)
- [New-code-only lint](#new-code-only-lint)
- [.fallowrc.json](#fallowrcjson)
- [Git hooks (OWN_HOOKS)](#git-hooks-own_hooks)
- [CI (OWN_CI)](#ci-own_ci)
- [Agent files](#agent-files)
- [Verify](#verify)
- [Token audit](#token-audit)

Recipes for step 7 when `detect.mjs` reports `mode: adopt` or `upgrade`. The rule: the system fits
the project, not the reverse. Keep its tools, add our checks to them, gate only new code, and
write any move toward the defaults into `context/plans/adoption.md` instead of doing it.

## Linting (`OWN_LINTER`)

Keep the project's linter and formatter. oxlint is installed regardless (anti-slop), so the
architecture and naming rules that `biome.json` carries for new projects go into
`oxlint.config.ts`, merged with what the anti-slop skill wrote. Map paths to this repo's real
layers (`detect.mjs` `layerDirs`); drop a rule whose layer does not exist.

```ts
plugins: ["unicorn", "oxc", "import"],
rules: {
  "unicorn/filename-case": ["error", { case: "kebabCase" }], // only if the repo is kebab-case already
  "oxc/no-barrel-file": ["error", { threshold: 0 }],          // bans `export *`, allows named re-exports
},
overrides: [
  {
    files: ["<modules root>/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["drizzle-orm", "drizzle-orm/**", "next", "next/**", "react", "react/**"],
          message: "Domain modules import no framework or ORM: declare a port." },
      ] }],
      "no-restricted-globals": ["error", { name: "fetch", message: "Use the shared HTTP client." }],
    },
  },
  {
    // Later overrides replace earlier ones for the same rule: repeat the framework group here.
    files: ["<modules root>/*/index.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["../**"], message: "index.ts exports only its own folder." },
        { group: ["drizzle-orm", "drizzle-orm/**", "next", "next/**", "react", "react/**"],
          message: "Domain modules import no framework or ORM: declare a port." },
      ] }],
    },
  },
],
```

A rule the existing code breaks everywhere (e.g. file naming in a camelCase repo) is not added;
record it as a divergence instead.

## New-code-only lint

The gates run `lint:changed` (`CMD_LINT` in the answers); `lint` stays the full run.
Add `"lint:changed": "node scripts/lint-changed.mjs"` to `package.json` and create the
script below. Set the confirmed base and existing linter; include oxlint only for full setup.
It checks branch changes, staged/unstaged edits, and untracked files; Git and lint failures
remain failures, and filenames with spaces stay intact.

```js
import { spawnSync } from "node:child_process";

const base = "origin/main"; // Replace with the confirmed default branch.
const linters = ["biome", "oxlint"]; // Or ["eslint", "oxlint"]; lean: existing linter only.
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || result.error?.message);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}
const since = run("git", ["merge-base", base, "HEAD"]).trim();
const files = [...new Set([
  ...run("git", ["diff", "--name-only", "--diff-filter=ACMR", "-z", since]).split("\0"),
  ...run("git", ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
])].filter((file) => /\.[cm]?[jt]sx?$/.test(file)).map((file) => `./${file}`);
if (files.length) {
  for (const linter of linters) {
    run(linter, [...(linter === "biome" ? ["check"] : []), ...files]);
  }
}
```

Package scripts put installed linter binaries on `PATH`. For projects with other source formats,
extend the file filter to those handled by the configured linters.

Fallow needs nothing extra: `"fallow": "fallow audit --quiet"` only fails on findings the branch
introduces.

## `.fallowrc.json`

Not rendered in adopt mode. Start from `npx fallow recommend --format json` (`proposed_config`:
entries, workspaces), then add `boundaries` from the real layers: one zone per layer that must
not be imported from somewhere (db/repositories, routes), and for module folders the
`module-api` (`<root>/*/index.ts`) + `autoDiscover` pair from the template. Run `fallow
dead-code --boundary-violations` once and record the count in the adoption plan.

## Git hooks (`OWN_HOOKS`)

Never run `conventions.mjs install-hooks` and do not add the `prepare` script: it repoints
`core.hooksPath`. Add these lines to the existing hooks instead.

| Tool | pre-push | commit-msg |
| --- | --- | --- |
| husky | append to `.husky/pre-push` | append to `.husky/commit-msg` |
| lefthook | `pre-push.commands.<name>.run` in `lefthook.yml` | `commit-msg.commands.<name>.run` |
| plain `core.hooksPath` dir | append to its `pre-push` | append to its `commit-msg` |

```sh
# pre-push
<runtime> scripts/git/conventions.mjs current
<runtime> scripts/checks/docs-check.mjs
<run> lint:changed
<run> fallow
# commit-msg (husky passes the message file as $1)
<runtime> scripts/git/conventions.mjs title "$(sed -n '1p' "$1")"
```

## CI (`OWN_CI`)

Add steps to the workflow that already runs on `pull_request`; never a second CI file. Copy them
from `templates/.github/workflows/ci.yml`: the `conventions` job, and in the checks job
`fetch-depth: 0` on checkout plus the Docs and fallow steps. `merge-gate.yml` is still rendered —
add it as a required check.

## Agent files

- `AGENTS.md` / `CLAUDE.md`: keep every project rule. Add the system's missing sections
  (verification table, "what to read" routing, workflow skills) and move long topic prose into
  `context/`, leaving a link. `CLAUDE.md` gains `@AGENTS.md` if it lacks it.
- `.claude/settings.json`: merge `permissions.allow` entries and `hooks.Stop` from the template;
  keep everything already there.
- Existing `.agents/skills`: keep; regenerate the catalog with `scripts/skills/index.mjs`.
- No plan document: `docs/archive/product-brief.md` records the README's description and the
  user's answers. Every FILL is written from the code and the user, never invented.

## Verify

On a branch with no code change, every gate passes despite the debt. Then plant one violation per
gate (a deep import past `index.ts`, a dependency without a library-docs row, a bad commit
title), see each fail, and revert.

## Token audit

An adopted project often arrives with MCP servers, skills, and long agent files already loaded
every session. Run the audit in [token-tools.md](token-tools.md) at hand-off; it reports, it
does not trim.
