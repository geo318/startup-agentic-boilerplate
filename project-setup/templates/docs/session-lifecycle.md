# Session lifecycle

Read when starting app work, launching local services, handing off, or recovering leftovers.
Node 22+ is required; macOS/Linux process inspection uses `ps` and `lsof` (Linux: install your
distribution's `lsof` package; macOS includes it). No runtime dependencies or global daemon.

## Start a thread

Read the current request and relevant memory before choosing intent. Then, from the project root:

```bash
{{RUNTIME}} scripts/session/cli.mjs begin --intent fresh
```

Pass `--session <id> --turn <turn>` when provided by native hooks. Without hooks, retain the IDs
printed by begin and supply them on subsequent commands. Reuse the session ID across turns;
begin reacquires the checkout lease without refreshing Git again. Always use the returned
checkout, including an isolated checkout. In the next turn call begin again to reacquire.

Fresh initialization switches to `{{DEFAULT_BRANCH}}` and pulls with `--ff-only`, once per
thread. The default remote is the branch's configured remote or `origin`; `--remote <name>`
selects another configured remote. An explicit branch/PR/review or unfinished work uses
`--intent continue --reason <evidence>`. `--intent target --ref <ref> --reason <request>` selects
a verified ref in a safe detached checkout. Neither mode authorizes overwriting work.

Dirty/staged/untracked files, feature commits, detached context, ongoing Git operations, local
default-branch divergence, and unavailable process inspection preserve the checkout and return
a reason. Offline or missing remote state stays explicitly unverified. Nothing automatically
stashes, resets, rebases, force-switches, or deletes branches. Concurrent checkout users and
running listeners select an isolated worktree; `--isolate` explicitly requests that path.
If current upstream truth is essential and fetching failed, report the dependency as blocked.

## Launch and finish

```bash
{{RUNTIME}} scripts/session/cli.mjs run --session <id> --turn <turn> --label web -- <executable> <args>
{{RUNTIME}} scripts/session/cli.mjs status --json
{{RUNTIME}} scripts/session/cli.mjs finish --session <id> --turn <turn>
```

For this project's normal dev command, pass its executable and arguments after `--` instead of
starting it directly. Shell syntax is not evaluated: use a package script for pipelines or env
setup. `--foreground` forwards output and waits for completion; it renews a busy lease during
long builds/tests. Background processes discard output; status reports actual listeners through
lsof, including framework-selected fallback ports. A service can briefly show no listener while
starting. Inspect status and verify the actual endpoint before claiming the app works.

Compatible managed services share leases, including while launch is pending; concurrent callers
wait for the same launch and receive a failure if it cannot start. Foreground commands run
independently. Command/cwd/source fingerprints prevent reuse across
different checkouts or settings. Untracked files disable cross-thread reuse. A pre-existing
compatible server can be recorded with `borrow --session <id> --label web --pid <pid>`; this
never transfers ownership. Occupied ports do not authorize terminating their listeners.

Finish releases this turn's temporary leases after verification and before final handoff.
The last lease stops the owned process tree, escalating only against revalidated identities.
Other threads' leases and borrowed/user services survive. Managed servers, watchers, local
tunnels, and ordinary child processes are supported. Daemonizing programs that detach into
unobserved process groups, arbitrary GUI apps, browser tabs, and containers need dedicated
adapters and are not currently supported. Never claim these are cleaned automatically.

If explicitly asked to keep a preview available, add `--retain 7200 --reason <request>` to run.
This keeps a visible lease for two hours after handoff; the maximum is one day. To end retention
early, use `finish --session <id> --release-retained`, or let the documented expiry run;
ordinary finish preserves intentional retained leases. Do not ask about retention routinely.

## State and recovery

The source of truth is a private, versioned `agent-runtime/v1/state.json` beneath Git's common
directory. Linked worktrees share it. Before Git exists, `.agents/.runtime/` is the local
fallback; existing thread records keep that registry across Git initialization and linked
worktrees discover it through the primary checkout. Once those records retire, new state uses
Git's common directory.
`.agents/sessions.md` is a generated, gitignored view of active resources and cleanup failures.
It is zero bytes at rest. Compact initialization markers remain outside this document for
once-per-thread behavior and expire after 30 idle days. Never edit runtime files to hide a leak.

`sweep` retries abandoned resources and refreshes the view. Native hooks renew active leases;
temporary idle leases expire after 30 minutes. Without hooks, use `touch --session <id>` during
long background investigations or a managed foreground command for busy work. A verified
long-lived owner can be supplied to begin with `--owner-pid <pid>`; do not use a temporary shell
or the CLI itself as the conversation owner.

Each managed service has an ephemeral supervisor, with no TCP control port. It handles expiry
and persisted end/interrupt requests, then exits. If it is killed, the next lifecycle command
recovers recorded descendants. Nothing runs while the machine is off. Cleanup failures stay
visible and return nonzero from the CLI; process-inspection/permission failures do not authorize
guessing a PID's owner. Corrupt or redirected registry paths stop managed operations.

Inspection worktrees are removed only when detached at their original commit, unchanged, and
unleased. Sweeps retry removal after interrupted-session resources drain, or on the next lifecycle
entry if no supervisor exists. Changed worktrees and their recovery records survive expiration;
follow the project's Git delivery policy for feature work.
User data, volumes, databases, output artifacts, and unrelated processes are never swept.

## Native hooks and setup

Root instructions and the sweep skill work without hooks. Claude settings include lifecycle
hooks when `CLAUDE_CODE` is configured. `CODEX_HOOKS` explicitly enables `.codex/hooks.json`
for supported local Codex clients. Preserve existing configuration and add hooks through the
normal adoption/sync merge process. Hook trust and sandbox/organization policy still apply.

The adapter registers a session before the first prompt; it defers Git mutation until the agent
knows the user's intent. Supported pre-tool hooks remind/block uninitialized shell/edit work.
Read-only preflight remains available. This is an agent guardrail, not a complete shell sandbox.
Stop runs existing completion checks before releasing resources; check retries keep their
resources. End/failure/interrupt callbacks persist a short cleanup request for the supervisor.

Verify your installed client/version and orchestration mode before relying on native events.
Codex requires native review/trust of new or changed hook definitions. Cloud-orchestrated hosts
may not execute project shell hooks; use begin/run/finish and report native automation as
unavailable in that environment. Never bypass hook trust to remove a setup prompt.
See [Codex hooks](https://learn.chatgpt.com/docs/hooks) and
[Claude hooks](https://code.claude.com/docs/en/hooks).

No routine consent is needed for this project's branch refresh and exact owned-resource release.
An empty view establishes that the registry has no active/unresolved managed resources; it does
not claim the whole computer has no listeners. Report actual Git/cleanup exceptions briefly.
