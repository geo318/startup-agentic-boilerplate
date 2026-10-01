# Migration and rollback

## Documentation mode → runtime enabled

1. In `docs/archive/project-setup.answers.json` set `flags.AGENTIC_RUNTIME: true`, add `vars.GATE_DISCOVER_REGEX`
   (one capture group: tests discovered) and, if wanted, `flags.AGENTIC_ALLOW_HOSTED` / `vars.AGENTIC_DOCKER_IMAGE`.
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
