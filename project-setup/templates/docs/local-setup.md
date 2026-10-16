# Local setup

Secrets are never written here. Real values live in `.env` (gitignored); `.env.example` lists every
variable.

## Prerequisites

<!-- FILL: runtime + version (e.g. Bun 1.x / Node 22+), database (local or hosted dev branch), and any CLIs (vercel, stripe, eas…). -->

## First run

```bash
{{CMD_INSTALL}}
cp .env.example .env   # then fill in values
# Agent sessions: begin, then pass the dev executable/args through the session launcher.
```

<!-- FILL: anything else the first run needs, in order — database creation/migration, seed data, creating a dev login. Mark steps that touch shared or production resources. -->

## Running

For agent work, use [session lifecycle](session-lifecycle.md) to initialize Git, launch these
commands through the managed launcher, and release temporary resources at handoff.

| What | Command | Port |
| --- | --- | --- |
{{#each APPS}}
| {{APP_NAME}} | `{{APP_DEV}}` | {{APP_PORT}} |
{{/each}}
{{#unless MONOREPO}}
| {{PROJECT_SLUG}} | `{{CMD_DEV}}` | <!-- FILL: port --> |
{{/unless}}

## Gotchas

<!-- FILL: leave as "None recorded yet." on day one. Add a bullet each time a setup problem costs someone more than ten minutes. -->
