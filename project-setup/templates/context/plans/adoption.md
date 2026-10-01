# Adoption plan

{{PROJECT_NAME}} adopted this documentation and guardrail system on {{SETUP_DATE}}, on top of its
existing code and tooling. The gates judge only new code (`{{CMD_FALLOW}}`, changed-file lint), so
the debt below never blocks work. Nothing here is done without the developer asking for it.

## Debt at adoption

<!-- FILL: dated snapshot from the first runs — fallow totals (unused files/exports/deps, boundary violations, duplication %, functions over cognitive 30) and the full-repo lint error count. One line each. This is the baseline later cleanups are measured against. -->

## Divergences

Where this repository differs from the system's defaults, and whether that is kept on purpose.

| Area | Observed here | System default | Keep or move |
| --- | --- | --- | --- |
<!-- FILL: one row per real divergence found while filling the docs — layout (e.g. "services/ beside routes" vs domain modules), naming (camelCase files), tooling (ESLint instead of Biome), request path shortcuts, tests. "Keep" needs a one-line reason; "move" links a step below. -->

## Moves

<!-- FILL: incremental moves toward the defaults, smallest and safest first. Each: what changes, which files, how it is verified, and that it ships as its own branch. Example: "Name module entry points: add index.ts to each of src/modules/* and switch imports to it — fallow boundaries then enforce it." Write "None planned." if every divergence is kept. -->
