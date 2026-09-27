# Project overview — {{PROJECT_NAME}}

## What it is

{{ONE_LINER}}
<!-- FILL: one paragraph from the brief: the problem, who has it, and what the product replaces or improves. Facts only; anything the brief leaves open goes to build-plan.md "Open questions", not here. -->

## Users and their jobs

| User | Primary jobs |
| --- | --- |
<!-- FILL: one row per user type in the brief (e.g. owner, staff, end customer, admin). Jobs are verbs: "book an appointment", "approve a refund". -->

## Non-goals

<!-- FILL: 2–5 bullets the brief explicitly excludes, or that the user confirmed at intake. They stop agents from gold-plating. Delete this section only if the user declined to name any. -->

## Tech stack

| Layer | Choice |
| --- | --- |
<!-- FILL: one row per layer from the confirmed stack (runtime, framework per app, database/ORM, auth, validation, lint/format, tests, hosting, jobs, payments, AI...). -->

## Apps

| App | Framework | Purpose |
| --- | --- | --- |
{{#each APPS}}
| `{{APP_DIR}}` | {{APP_FRAMEWORK}} | {{APP_PURPOSE}} |
{{/each}}

{{#if MONOREPO}}
## Packages

| Package | Purpose |
| --- | --- |
<!-- FILL: one row per shared package from the stack preset. State what it owns and, where it matters, what it must not import. -->

{{/if}}
## Product areas

<!-- FILL: bullet per product area from the brief — **Name** — one-line description. These become code-map rows and build-plan milestones. -->
