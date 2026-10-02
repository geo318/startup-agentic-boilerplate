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

Pull the new **boilerplate/runtime checkout**, review the diff, then run the explicit upgrade below. Pulling only the
consumer project does not update an external runtime checkout. The launcher still refuses a mismatched runtime pin.

### Model routing and pre-edit budget upgrade

From the updated boilerplate checkout, target your existing project:

```bash
node packages/agent-runtime/src/cli/main.ts upgrade --project /absolute/path/to/project --execution handoff
```

For sibling checkouts, `/absolute/path/to/project` can be `../family-tracker`. Run the **direct CLI**, because the old
consumer launcher may refuse the new runtime hash. The command backs up the original `models.json` and `runtime.json`
under `$AGENTIC_HOME/upgrades/` and prints the backup path. It preserves unused profiles, policy, qualifications, and task
history; selects distinct manual worker/architect/reviewer routes; and pins the updated runtime. It makes no model calls
and grants no qualifications. Repeating the command preserves the migrated routes.

Use `--execution delegated` instead to keep the current role mappings and explicitly authorize their configured
providers. This does **not** change Sonnet into your chat model. To change a delegated model, edit its profile deliberately,
check provider support, and qualify the new identity. Switching back from handoff does not restore old role mappings;
recover those from the backup if wanted. No command detects your chat's model or reasoning setting.

Then, from the consumer project:

```bash
node scripts/agentic.mjs doctor
node scripts/agentic.mjs qualify current-harness-worker
# Only with the owner's explicit declaration of these capabilities:
node scripts/agentic.mjs qualify current-harness-architect --owner-declare architecture
node scripts/agentic.mjs qualify current-harness-reviewer --owner-declare review
node scripts/agentic.mjs task create /path/to/new-smaller-contract.json
node scripts/agentic.mjs task preflight <new-task-id>
node scripts/agentic.mjs task run <new-task-id>
```

`doctor` shows the actual selected names (use those if existing names collided). Handoff qualification and task commands
wait for JSON replies: follow the [packet exchange instructions](../packages/agent-runtime/README.md#using-your-current-chat).
They do not launch another model. Egress must already allow hosted/manual exchange; the upgrade never changes consent.
A handoff label identifies an operator-controlled route, not a measured model. Requalify when changing the answering model.

Review and commit `.agents/models.json` and `.agents/runtime.json`. Other machines still need the matching runtime checkout
and their own qualifications. No scaffold rerun or AGENTS replacement is needed for these runtime fixes. If you also sync
new template guidance, preview with `--sync --dry-run`; reconcile locally edited files instead of overwriting them.
Existing owner authorization to upgrade applies; do not ask for it again merely because `.agents/` is protected from workers.

Terminal `ESCALATED`/`BLOCKED` tasks stay terminal. Preserve FP-601's original history and create a smaller replacement contract
with a new ID and explicit scope; repeat required plan approval and verification. The controller now stops before another
call when an unchanged candidate has already used 3 calls (including planning), or the next reservation would exceed 60%
of the task token cap. Planning uses at most 4,000 context and 1,500 output tokens. Provider overhead can exceed estimates;
this guard prevents additional spending, not a hard provider-side cap or a guarantee that a task will finish.

To undo the routing migration, restore the printed backup files **and** the runtime revision matching the restored pin.
Do not delete task history or disable policy to resume a refused task.

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
