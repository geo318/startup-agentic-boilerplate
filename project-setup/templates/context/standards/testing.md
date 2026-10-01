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

## What counts as verified

Unit tests prove logic. They do not prove that a route is mounted at the path you think, that a
page renders, or that a migration applied. For those, exercise the running system and record what
you observed.
