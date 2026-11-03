# Review instructions

Rules for Claude Code Review on pull requests. Project rules live in AGENTS.md, read through
CLAUDE.md; a change that breaks one of its invariants is a finding. Code Review reads this file
from {{DEFAULT_BRANCH}}, not from the pull request, and honors the severity, skip, and nit rules
below only while {{DEFAULT_BRANCH}} is protected. Keep it free of Markdown links.

## What Important means here

Reserve Important for findings that would:

- break behavior, or lose or corrupt data
- leak data or secrets
{{#if HAS_AUTH}}
- bypass authorization
{{/if}}
{{#if MULTI_TENANT}}
- read or write across a tenant boundary
{{/if}}
{{#if HAS_DB}}
- ship a migration that is not backward compatible
{{/if}}

An AGENTS.md invariant violation is Important when it has one of these effects, Nit otherwise.
Style, naming, and refactoring suggestions are Nit at most.

## Cap the nits

Report at most five Nits per review.

## Do not report

- Anything CI already enforces: lint, formatting{{#if TYPESCRIPT}}, type errors, import boundaries,
  dead code, duplication, complexity{{/if}}, branch and commit names, broken doc links, doc budgets.
- Lockfiles, `docs/archive/project-setup.lock.json`, and `.agents/skills-index.md` (generated).
- Upstream skills listed in `skills-lock.json`; they are vendored as-is.
- Test-only code that intentionally breaks production rules.

## Always check

- New behavior has a test that would fail without it; a bug fix carries a regression test.
- No secrets, tokens, or personal data in code, logs, or error messages.
{{#if HAS_AUTH}}
- Every new route or action checks authorization for the route and for each row it touches.
{{/if}}
{{#if MULTI_TENANT}}
- Every query on tenant-owned data is scoped to the caller's tenant.
{{/if}}
{{#if HAS_AI}}
- Model output is validated against its schema before use.
{{/if}}
- A change to behavior, a boundary, or a rule updates its doc under `context/` in the same PR.
<!-- FILL: 0–5 project-specific checks from the brief that CI cannot enforce and AGENTS.md does not already state, one bullet each; delete this marker if none. -->

## Evidence

Behavior claims need a file:line citation in the source, not an inference from naming. Drop a
finding you cannot verify in the code.
