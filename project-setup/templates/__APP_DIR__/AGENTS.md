# {{APP_DIR}}: {{APP_NAME}}

{{APP_PURPOSE}} Built with {{APP_FRAMEWORK}}. These rules add to the root
[AGENTS.md]({{APP_ROOT_REL}}AGENTS.md) invariants; they never override them.

## Dev loop

1. Start from the repository root; launch `{{APP_DEV}}` through the
   [session launcher]({{APP_ROOT_REL}}docs/session-lifecycle.md#launch-and-finish).
   Reuse a compatible managed server and release its lease at handoff.
2. <!-- FILL: framework-specific step — e.g. for Next.js "use the `next-dev-loop` skill for the dev loop, and read the version-matched guide in node_modules/next/dist/docs/ before editing"; for Expo "Metro is shared; one instance only". -->
3. After editing, verify in the running app — <!-- FILL: how (browser via Playwright/devtools MCP, curl against the local API, simulator) -->. A typecheck is not verification.

## Scoped rules

<!-- FILL: 3–8 bullets that apply only to this app: its layer in the request path, which packages it may and may not import, framework rendering/runtime rules, bundle or performance budgets. Link to context/ topics instead of restating them. -->

## Runtime and deployment

<!-- FILL: how this app runs in production (host, runtime, entry file, build command) and the deploy trigger. "(planned)" is fine on day one. -->
