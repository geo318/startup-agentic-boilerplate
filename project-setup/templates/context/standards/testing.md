# Testing

```bash
{{CMD_TEST}}
{{CMD_TEST_CHANGED}}
{{#if HAS_E2E}}
{{CMD_E2E}}
{{/if}}
```

<!-- FILL: the test runner(s) and any other test commands the stack defines (unit vs integration split, coverage). -->

## Conventions

- Colocate tests with the source: `name.unit.test.ts` for pure/unit tests,
  `name.integration.test.ts` for tests that need a database or network. No `__tests__` trees.
- Each test states one situation and asserts what a caller or user observes, not how the code is
  structured internally.
- Mock at architectural boundaries (the feature hook, the repository port, the HTTP client), not
  deep inside modules. Prefer dependency injection over module mocking.
- A bug fix lands with a test that fails without the fix.
{{#if TYPESCRIPT}}
- Architecture rules live in config, not tests: boundary zones in `.fallowrc.json`, banned imports
  and globals in {{#if OWN_LINTER}}`oxlint.config.ts`{{else}}`biome.json`{{/if}} overrides. An exception is an inline
  `fallow-ignore-next-line` or {{#if OWN_LINTER}}`oxlint-disable-next-line`{{else}}`biome-ignore`{{/if}} comment with its reason, approved by the user —
  debt to shrink, never an example.
{{else}}
- Architecture rules that matter (import boundaries, forbidden calls) are enforced by a lint rule
  or a test, not prose. An exception carries a written reason and the user's approval — debt to
  shrink, never an example.
{{/if}}

## Guardrails: write the test that earns its place

A test is worth keeping only if it would fail on a real regression. Before adding one, name the bug
it prevents. If you cannot, skip it.

**Write a test when:**

- **A bug was fixed.** Reproduce it first and watch it fail; the test is the permanent guard. Fix
  the class of bug, not only the instance (test the sibling callers too).
- **An invariant exists.** Each invariant in `AGENTS.md` that code can break (tenant scoping,
  authorization, money in minor units, idempotent jobs) has one test that tries to violate it.
- **Logic branches or has edge cases:** parsing, state transitions, permissions, money, dates,
  retries. Cover boundaries and the error path, not three happy-path variants.
- **A contract crosses a boundary:** a repository against the real database, an adapter against
  its port, a webhook or API payload shape. Integration tests, not mocks, prove these.
- **A user-critical flow spans layers** (sign-up, checkout, the main job of the product): one e2e
  per flow, happy path plus the single failure that costs the most. Not one per component.

**Do not write:**

- Tests that restate the implementation: mock returns X, assert X was returned; asserting a
  constant, a type, a default, or that a call happened with the arguments you just passed.
- Snapshots of large output, or tests of getters, pass-throughs, config, and framework behaviour.
- Several tests for one behaviour. Use a table of cases when only the data differs.
- E2E for what a unit or integration test proves faster. Pick the lowest layer that can fail for
  the reason you care about.
- Mocks of the thing under test, or fakes that cannot fail the way the real adapter does.

**Hygiene:**

- Deterministic: inject clocks, ids, and randomness. No sleeps, no order dependence, no live
  network or third-party calls outside a deliberately marked live script.
- Never weaken or delete a failing test to get green. Fix the code, or change the test and say why
  the old expectation was wrong.
- Before finishing, delete any test you added that you could not justify by the rules above.

## What counts as verified

Unit tests prove logic. They do not prove that a route is mounted at the path you think, that a
page renders, or that a migration applied. For those, exercise the running system and record what
you observed.
