# Migration and rollback

## Documentation mode → runtime enabled

1. In `docs/archive/project-setup.answers.json` set `flags.AGENTIC_RUNTIME: true`, add `vars.GATE_DISCOVER_REGEX`
   (one capture group: tests discovered) and, if wanted, `flags.AGENTIC_ALLOW_HOSTED`.
2. Preview: `node project-setup/scripts/scaffold.mjs --answers <file> --target <repo> --sync --dry-run`.
3. Apply without `--dry-run`. Only new files are created (`.agents/policy.json`, `.agents/models.example.json`,
   `scripts/agentic.mjs`); skills that you have not edited are updated, edited ones land in `.project-setup/sync/`.
4. Pin the runtime from its checkout: `node <runtime>/src/cli/main.ts pin --project <repo>`, commit `.agents/runtime.json`.
5. Copy `models.example.json` to `models.json`, edit it, then `node scripts/agentic.mjs doctor`.

## Upgrading templates

`--sync` compares each file with the hash recorded in `docs/archive/project-setup.lock.json`
(`$meta.templatesHash` shows whether the templates changed). Untouched files update; edited ones are never overwritten.

## Upgrading the runtime

Pull the new runtime, review the diff, re-run `pin`. The launcher refuses a runtime that differs from the pin, so an
upgrade is always a deliberate, reviewable commit.

## Rollback

- Disable: set `AGENTIC_RUNTIME` false. Delete `.agents/policy.json`, `.agents/models*.json`, `.agents/runtime.json`,
  `scripts/agentic.mjs` (all additive; nothing else depends on them). Documentation mode is unchanged.
- Task state is outside the repo (`$AGENTIC_HOME`, default `~/.agentic`); delete a task folder to purge it.
- Accepted work is only a patch (`task export`) until you apply it; revert it like any commit.


## Audit-fix upgrade

- Re-pin after upgrading. Start new tasks: policy binding now includes write scope and existing-test protection; old in-flight tasks may refuse stale policy evidence.
- A Jev key no longer enables calls. Set explicit modes, or `jev.auto: true` for workflow routing only, if the experiment is intended.
- Contracts without `scope` permit writes only to `files` plus `newFiles`. Add exact paths or trailing-slash directory prefixes deliberately. Declare new context files in `newFiles`.
- Existing conventional tests are frozen by default. Put custom acceptance scripts in `protectedPaths`; modify trusted tests through reviewed maintenance, not ordinary worker edits.
- `session-check` reruns unless `--reuse` is explicitly requested. Failed results are never reused.
- Select `flags.LEAN: true` for a new small project. Sync does not delete old full-preset docs; remove obsolete files and links deliberately when migrating an existing project.

- Stats now verifies event chains and refuses unreadable task/session history. Preserve and repair damaged records from a known-good backup before reporting. New tasks record controller execution time separately from elapsed time; older histories show execution timing as unavailable. Interrupted hosted calls are flagged as unknown cost before or after resume.
