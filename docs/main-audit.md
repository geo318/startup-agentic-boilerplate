# Main-branch audit — 2026-10-05

Baseline: `main` at `57e41d8`. The five pre-existing staged changes are incorporated into
these audit fixes, with redundant guidance consolidated. Review criteria were
observable correctness, failure handling, maintainability, and necessary complexity; repository
claims were evidence to inspect, not proof of quality.

## Findings and fixes

Line references below identify the revised files.

| Priority | Location | Reproduction or evidence | Resolution |
| --- | --- | --- | --- |
| High | [scaffold.mjs](../project-setup/scripts/scaffold.mjs):305 | A symlinked output directory or file can redirect renderer writes outside the target. | Reused the existing staged output-path guard and regression test, including its hardlink guard, rather than implementing a competing fix. |
| High | [adopt.md](../project-setup/references/adopt.md):59 | The old Biome recipe exits zero when Biome exits 7 and there are no changed files. Shell splitting also breaks filenames with spaces; triple-dot diffs omit uncommitted edits. | Replaced two shell recipes with one documented Node runner using argument arrays, NUL-delimited filenames, a merge base, and explicit failure propagation. Test executes the documented code. |
| Medium | [detect.mjs](../project-setup/scripts/detect.mjs):216 | On `feat/work` with local `main` but no origin HEAD, detection calls `feat/work` the default branch. | Prefer origin HEAD, then existing main/master; report an unknown for unresolved custom defaults. Do not manufacture a changed-test command with an unknown base. |
| Medium | [detect.mjs](../project-setup/scripts/detect.mjs):70 | Malformed package JSON is treated as absent; a nonexistent target is treated as a new empty project. | Fail with a diagnostic for invalid/unreadable input; only absent manifests are optional. Reject extra CLI arguments. |
| Medium | [agent-stop.mjs](../project-setup/templates/scripts/checks/agent-stop.mjs):71 and [.claude/settings.json](../project-setup/templates/.claude/settings.json) | Lean rendering still requires `CMD_FALLOW` through permissions and can invoke an existing fallow binary. Its hook also omits strict docs budgets. | Omit fallow permissions/checks for lean and non-TypeScript output; apply strict docs checking to lean Stop and pre-push hooks. |
| Medium | [pre-push](../project-setup/templates/.githooks/pre-push):4 | A non-TypeScript generated hook succeeds without running a failing lint command. | Run the confirmed linter for every stack; preserve its failure. Remove duplicated docs-check branches. |
| Medium | [docs-check.mjs](../project-setup/templates/scripts/checks/docs-check.mjs):253 and [code-standards.md](../project-setup/templates/context/code-standards.md):13 | Lean dependency errors direct users to an omitted skill; full standards require a skill even though root guidance allows official docs. | Give a usable docs/skill/needs-no-notes remedy and align setup guidance. |
| Low | [AGENTS.md](../project-setup/templates/AGENTS.md):76 and [.agents/README.md](../project-setup/templates/.agents/README.md):17 | PR procedures and workflow triggers are repeated across always-loaded instructions and topic/index files. | Keep PR procedures in delivery and workflow triggers in root instructions; link from the other locations. Preserve distinct lean instructions and catalog responsibilities. |
| Low | [conventions.mjs](../project-setup/templates/scripts/git/conventions.mjs):56 | A character-by-character loop implements a simple kebab-case grammar. | Replace with an anchored expression; exercise valid/invalid branches and scopes through the CLI. Reuse the staged direct-string comparison in sync as well. |
| Medium | [review skill](../project-setup/templates/.agents/skills/review/SKILL.md) | Every invariant violation is classified as critical, regardless of impact, and repository rules can be treated as unquestionable. | Require independent correctness review and severity proportional to impact. |

The staged context-guide shortening and authorization-persistence wording were also retained in
this worktree. The staged review-trigger wording is represented by the canonical root workflow
guidance after removing its redundant copy.

## Verification

- Baseline: 33 tests passed before changes.
- Four new behavioral checks fail against an exported baseline: default-branch detection,
  invalid detector input, lean hooks, and non-TypeScript pre-push lint.
- The old adoption recipe separately reproduced a swallowed Biome exit 7.
- Final suite: 42 tests pass on Node 22.21.1 and Bun 1.4.2.
- Variant tests now validate rendered Markdown links and JSON; monorepo and docs-only cases
  actually enable their respective flags. Existing-tooling and full feature variants were added.
- An additional 16 lean/GitHub/TypeScript/Bun combinations passed JavaScript syntax checks and
  YAML parsing (24 workflow/dependabot files).
- Referenced checkout v7 and setup-node v5 tags were confirmed against their upstream Git refs.
- `git diff --check` passes. No dependencies added.

## Limits and retained choices

- GitHub workflows were parsed, not executed on GitHub. Framework generators, complete app
  builds, external linter semantics, Windows behavior, and Node 24 were not exercised locally.
- Workspace detection still documents support for exact paths and `dir/*`, not general glob
  semantics. Complex workspace layouts require manual intake review.
- The optional full preset retains its prescribed domain architecture and multiple lint tools.
  Their value depends on the target project; no evidence here justifies deleting that preset.
- Token counts remain estimates, not measured model quality or savings. This audit does not
  establish that every possible generated project or input combination is correct.
