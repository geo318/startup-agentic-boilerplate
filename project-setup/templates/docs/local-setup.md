# Local setup

Secrets are never written here. Real values live in `.env` (gitignored); `.env.example` lists every
variable.

## Prerequisites

<!-- FILL: runtime + version (e.g. Bun 1.x / Node 22+), database (local Docker or hosted dev branch), and any CLIs (vercel, stripe, eas…). -->

## First run

```bash
{{CMD_INSTALL}}
cp .env.example .env   # then fill in values
{{CMD_DEV}}
```

<!-- FILL: anything else the first run needs, in order — database creation/migration, seed data, creating a dev login. Mark steps that touch shared or production resources. -->

## Running

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
