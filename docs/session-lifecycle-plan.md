# Plan — fresh threads and automatic session cleanup

Status: implemented in the full/lean project templates on 2026-10-16. Requested through
`/architect`. The design below records the original decisions; implementation notes at the end
describe the shipped scope, differences, and verification limits.

## Outcome and scope

Ship this through the project-setup templates so generated projects get it in both full and
lean mode. Keep the runtime independent of Claude, Codex, the application framework, and the
package manager. Native hooks automate the lifecycle where supported; root instructions and
a `sweep` skill call the same commands elsewhere. This plan does not install global hooks,
change other projects, stop current processes, or publish a package.

The two observable defaults are:

1. Before a new thread investigates or changes the app, prepare an up-to-date default branch
   (`main` here), unless current instructions or verifiable checkout state require continuity.
2. At every completed handoff, release the temporary resources the agent created. The session
   document becomes empty when no active resource leases remain. Other threads' resources and
   pre-existing user services remain intact.

No recurring confirmation questions for these routine actions. Exceptions produce a concrete
status and a safe fallback. Ask only when the actual task cannot proceed without a decision
that existing instructions and repository state do not settle.

## Repository evidence

- Root and lean `AGENTS.md` templates restore `memory.md`, but have no Git startup guard.
- Root and app dev-loop templates say to reuse a running server, without recording ownership.
- `.claude/settings.json` wires only `Stop`, through `scripts/checks/agent-stop.mjs`.
- That script exits early on unchanged files and on `stop_hook_active`. Cleanup must not inherit
  either early exit. There are existing uncommitted changes to this script and its tests;
  implementation must preserve and integrate them.
- `scripts/scaffold.mjs` has an explicit lean allowlist. Merely adding a skill or runbook to
  templates would silently omit it in lean mode.
- The manifest currently has no Codex-hook output; intake and adoption guidance describe Codex
  as instruction-only. These compatibility claims must change alongside implementation.
- `docs-check.mjs` has an explicit owned-skill list and must recognize `sweep`.
- Delivery guidance already protects dirty/unpushed worktrees. Resource cleanup must not become
  an alternative path for deleting them.

## Language and boundaries

| Term | Meaning |
| --- | --- |
| Thread | One harness conversation; identified by the harness's session ID where available. |
| Turn | One stretch of agent work ending in a final handoff; steering messages do not create another owner. |
| Worktree | A specific checkout; branch changes affect everyone using that checkout. |
| Resource | A temporary process, listener, watcher, tunnel, browser context, or explicitly supported disposable container. |
| Owner | The runtime that created a resource and can prove its identity. |
| Lease | A thread/turn's current permission to use a managed resource. |
| Borrowed resource | A service already running before this runtime acquired a lease; never implicitly owned. |
| Sweep | Reconcile recorded resources with reality, release eligible owned resources, verify, then remove confirmed records. |

Ports are observations on resources, not ownership identifiers. Memory is a handoff note, not
runtime state or authorization. A clean Git status alone does not establish that work is finished.

## Decision 1 — Git initialization once per thread

### Context must precede mutation

`SessionStart` registers identity, inventories state, recovers abandoned resources, and supplies
a concise initialization instruction. It does not immediately switch branches: the opening
user prompt may name a PR, commit, or branch that has not yet reached the agent.

After reading the current request and relevant continuity evidence, the agent calls `begin`
before substantive app investigation, edits, or server startup. This is automatic agent work,
not a question to the user. Initial instruction reads and read-only Git preflight are allowed.
The intent contract is:

```text
begin --intent fresh
begin --intent continue --reason <current instruction or verified state>
begin --intent target --ref <requested ref> --reason <current instruction>
```

The script independently checks Git safety; `--intent fresh` cannot override dirty files,
checkout ownership, a worktree lock, or ongoing Git operations. A short reason is recorded for
every exception. Do not infer intent with a shell regex over the user's prose.

Native pre-tool adapters remind/block supported substantive local actions when initialization
is pending, while allowing the exact lifecycle/preflight entrypoints. They return actionable
feedback to the agent, without an approval dialog. Do not claim the adapter is a sandbox or a
complete shell-command parser. Unsupported tools retain the instruction-based requirement.

### Safe fresh-checkout sequence

1. Resolve the canonical repository and checkout, including starts from an app subdirectory.
   Acquire a repository mutation lock and a checkout lease. Re-read state after locking.
2. Examine tracked, staged, and untracked changes; branch and upstream; linked worktrees;
   ongoing merge/rebase/cherry-pick/revert/bisect operations; active checkout users; and relevant
   running services. Do not move a checkout used by another active thread or a known server.
3. Fetch the configured remote with bounded, noninteractive authentication. Check actual refs,
   ancestry, and local commits. Do not infer success from condensed display output.
4. If safe, run the equivalent of `git switch main` followed by
   `git pull --ff-only origin main`. Render the configured `DEFAULT_BRANCH`; do not hardcode
   `main` in generated projects. Pin fast-forward behavior despite local pull configuration.
5. Record the resulting branch, commit, remote, time, and `synced` status. Persist a compact
   once-per-thread marker separately from the active-resource document.
6. Release the short mutation lock. Keep the checkout lease while the turn is active, including
   while a managed watcher uses that checkout.

Never automatically stash, reset, discard, merge, rebase, force-switch, or delete a branch.
Fetching may update remote-tracking refs even when switching is skipped; do not call that a
successful checkout sync. Check local-main ahead/diverged state explicitly, since a successful
pull can still leave local commits ahead of the remote.

### Exceptions and automatic behavior

| Evidence | Behavior without a confirmation question |
| --- | --- |
| Resume, compaction, fork, review, or explicitly named branch/commit/PR | Preserve requested continuity; inspect refs without resetting the checkout. A fork gets a distinct thread identity and new resource leases. |
| Dirty index/worktree or untracked files | Preserve checkout and report `preserved-dirty`; continue work there when consistent with the request. |
| Existing feature branch with commits not contained in the default branch | Preserve it and report `preserved-branch`; do not treat a clean checkout as completed work. |
| Main ahead/diverged, in-progress Git operation, detached target, or explicit worktree selection | Preserve the context and state the reason. |
| Another active thread/server uses this checkout, or main is checked out elsewhere | For an independent fresh task, create a registered isolated worktree from the fetched default ref. Never steal the branch. |
| User explicitly needs fresh main while the current checkout must be preserved | Use an isolated worktree; never carry dirty files into another branch. |
| Offline remote, failed authentication, missing branch/remote, or fetch timeout | Preserve files; mark `unverified-offline` or the concrete failure. Local work may continue if compatible with the request. |
| Request requires current upstream truth but sync failed | Report that dependency as blocked; do not claim stale local results are current. |
| No Git repository or unborn branch | Record `not-applicable` / `uninitialized`; do not invent a remote. |

A new fresh thread on a clean, unused checkout with a stale branch that has no unique commits
can return to main. Explicit user/harness selection overrides that default. Historical memory
is checked against actual branch/ref state; a stale mention of a merged branch is not a permanent
reason to skip main. If reliable selection metadata is unavailable, preserve an ambiguous
branch rather than inventing evidence that it is disposable.

An isolated inspection worktree can be detached at the fetched default ref. Implementation work
uses the existing branch conventions. Its exact path/ref is returned to the agent, which must
use that cwd for every subsequent command; launching it does not change the harness's cwd.
If the host cannot execute reliably in the new cwd, preserve the original and report the limit.

`begin` is idempotent for the same thread and checkout. Additional prompts and compaction do
not repeat Git mutation. After a handoff the next turn reacquires a checkout lease and validates
its saved branch/commit against reality; unexpected movement becomes a reported continuity
exception. A new thread gets a new initialization decision.

## Decision 2 — runtime state plus an empty-when-idle document

Use structured state as the source of truth; render Markdown for inspection. A handwritten
shared Markdown table cannot safely coordinate concurrent agents or process identity checks.

```text
<git-common-dir>/agent-runtime/v1/
  sessions/<internal-session-key>.json
  resources/<resource-id>.json
  locks/
  receipts/                              bounded recovery/diagnostic metadata

<checkout>/.agents/sessions.md             generated local view; gitignored
```

Resolve `git-common-dir` through Git, not by assuming `.git` is a directory. Sharing state there
lets linked worktrees coordinate without a machine-global daemon or a tracked runtime file.
Different repositories remain isolated; operating-system port binding settles cross-repo
collisions. Each view shows active resources across this repository, with checkout paths.
The view is refreshed on local lifecycle activity and when inspected; JSON remains authoritative.
Before Git initialization, use a gitignored `.agents/.runtime/` directory beneath the explicitly
selected project root. Migrate it under the repository lock once Git exists; never guess a
parent repository or start an unmanaged process because Git metadata is unavailable.

Store only:

- Schema version; internal key; harness/thread/turn IDs; canonical checkout and repository IDs.
- Thread initialization decision; current checkout lease; owner process identity where verifiable.
- Resource ID/type, owning session, borrower leases, lifecycle status, creation/expiry times.
- PID plus process start identity and host boot identity; process group or exact container/context
  ID; runtime ownership token; actual listening addresses/ports when discovered.
- A configured command label and cwd; no raw environment, cookies, tokens, or arbitrary command
  arguments. Store exact validated paths for managed temporary outputs only.
- Last cleanup attempt, observed failure, and whether release was verified.

Use atomic writes and locks around mutations. Reject corrupt/unknown schemas and symlink/path
escapes rather than running cleanup from unvalidated metadata. Hash external IDs into path-safe
internal keys. Store state privately; an ownership token is not a security boundary against the
same operating-system user. Revalidate identities before signaling processes.

The Markdown view contains current leases and unresolved cleanup failures. At rest it is
absent or **zero bytes**; a status command can explain the empty state without writing a banner.
Remove each resource row only after verified release. Do not erase failures to make it look clean.
Compact once-per-thread markers are administrative state, not rows in the active document;
prune them with bounded age/count retention after no associated resources remain.

## Decision 3 — registration belongs to the launcher

The agent starts long-lived work through a managed command, rather than remembering to write
down PIDs afterwards:

```text
node scripts/session/cli.mjs begin --intent fresh
node scripts/session/cli.mjs run --label web -- <package-manager> run dev
node scripts/session/cli.mjs status
node scripts/session/cli.mjs finish
```

These commands are now included in generated projects. A dependency-free
Node runtime fits this package's Node 22+ requirement. Preserve documented Bun compatibility
only after running the same lifecycle tests with Bun.

`run` uses an argv array and a controlled cwd, creates a durable pending record, and performs a
supervisor/worker registration handshake before the application can create child processes.
Registration failure prevents launch. The pending-to-running crash window needs an explicit
recovery test; writing a PID after an ordinary detached spawn is insufficient.

For each requested service:

1. Reuse a healthy managed instance only when service identity, checkout, configuration label,
   and current source state are compatible; acquire another lease instead of another process.
2. A pre-existing service can be borrowed for compatible inspection. Record it as borrowed;
   never silently adopt ownership. Its presence can also prevent a checkout switch.
3. Otherwise launch a managed instance, capture its process tree identity, and discover the
   actual listener. Framework fallback ports must be recorded, not assumed from config.
4. Port collision: reuse only a verified compatible service; otherwise choose another port if
   the app supports it and propagate the actual URL. Never kill a process just to free a port.

The initial resource adapters cover local process trees: dev servers, watchers, emulators that
support headless termination, and tunnels launched through the wrapper. A browser adapter may
close an exact dedicated context/profile controlled by the supervisor; do not close the user's
browser or claim ordinary shared browser tabs are independently recoverable after a crash.
Container cleanup is enabled only for exact disposable containers created with ownership labels;
do not remove volumes, databases, Docker Desktop, or unrelated infrastructure. Unsupported GUI
apps remain outside automatic destructive cleanup until an exact-instance adapter exists.

Update root, app, lean, and local-setup dev commands to use this path. The skill is a fallback
and diagnostic entrypoint; it is not responsible for remembering registration. Pre/post-tool
checks detect observed bypasses and prompt the agent to correct them, without pretending that
arbitrary shell programs or connectors can be completely inferred or contained.

## Decision 4 — sweep at handoff, recover after interruption

### Normal finish

The agent verifies its work, invokes `finish`, and reports any actual residual resources.
The native Stop hook backs this up automatically. Resource cleanup does not depend on whether
source files changed, whether docs-check applies, or whether the verification retry guard fired.

Compose the existing check hook and lifecycle cleanup through one ordered adapter:

1. Run relevant checks. If a supported blocking check requests another agent pass, preserve
   resources needed for that correction and refresh its lease.
2. When allowing the handoff, release this turn's leases, then sweep resources with no remaining
   leases. Cleanup still runs on the existing recursion-guard path that skips repeated checks.
3. Return the harness-specific success/failure payload. Another independently configured Stop
   hook may still resume the agent; the next turn/pass must tolerate restarting a released server.
4. Do not make successful cleanup imply successful validation or suppress existing check failures.

For a releasable resource: mark stopping; revalidate its identity; request graceful termination;
wait a bounded interval; escalate only against that same proven owned process tree; recheck
listeners and descendants; remove its managed temporary outputs; then remove the confirmed row.
Suggested default termination budget: five seconds graceful plus two seconds verification and
escalation. Verify descendants even if the original parent has exited. If identity cannot be
proved, retain an actionable `unverified-owner` record and preserve the live process.

PID reuse is not a license to kill the replacement process. If evidence proves the original
resource is gone, close that original record and leave the unrelated replacement alone.
A port that has since been taken by someone else can remain open without constituting a leak.

Release only this thread's lease on a shared managed resource. Stop the resource only when the
last valid lease is released. Borrowed resources lose their informational row without being
stopped. Never use machine-wide `killall`, `pkill node`, or port-number-based termination.

### Interrupt, end, crash, and idle

Use four overlapping recovery paths:

| Trigger | Action |
| --- | --- |
| Explicit `finish` and normal Stop | Synchronously clean turn resources and confirm the result. |
| Supported interrupt/session-end callback | Persist a cleanup request and notify the existing supervisor; return within the callback deadline. |
| Owner dies or a temporary resource lease expires | The independent session supervisor sweeps eligible resources. |
| Next lifecycle entry in this repository | Reconcile pending records and abandoned owners, retry cleanup, refresh views, then initialize the new turn. |

Start the supervisor only when the first managed background resource is needed. Use inherited
pipes or local IPC, with no listening TCP port. It owns subprocess launch/control and exits once
its resources and cleanup requests are gone. No launchd service, cron, system settings change,
or permanently running global cleanup server is needed for the default path.

An idle temporary lease expires after 30 minutes by default. Hooks renew leases on activity;
supervised long-running foreground work sends a liveness heartbeat while the actual invocation
is active, so a long test/build is not killed merely for producing no tool events. An expired
background preview may be restarted automatically on the next use. Never infer death solely
from an old timestamp when a still-valid busy lease has independently verified liveness.

If the user explicitly asks to leave a preview available, create a visible retained lease with
a finite expiry (two hours by default), actual URL, and reason. That resource remains in the
document until released or expired. Do not ask about retention on every handoff; temporary is
the default. A later user instruction can extend or end retention.

If the supervisor itself is killed, startup reconciliation is the recovery guarantee. Immediate
cleanup after every possible process crash would require an additional always-on service;
do not promise that while claiming the default has no daemon. Nothing runs while a machine is
off. On reboot/resume, invalidate old boot identities and reconcile before trusting old PIDs.

Worktree/branch removal is deliberately separate from temporary runtime release. Automatically
remove only runtime-created inspection worktrees proven unchanged, unleased, and disposable.
Preserve feature worktrees, uncommitted files, local commits, user output artifacts, and shared
data. Classify and report them; follow existing delivery rules for any later Git cleanup.

## Harness integration and authority

Official Codex hook documentation was checked on 2026-10-16. Local hooks support startup,
prompt/tool activity, Stop, Interrupt, and SessionEnd. End and interrupt callbacks have short
deadlines; Stop and end are separate events. New/changed non-managed hooks require native
trust review. Cloud-orchestrated Work has different local-hook support. Tool-hook coverage has
exceptions. These facts require adapters and a fallback, not an unconditional support claim.
Source: [OpenAI hook documentation](https://learn.chatgpt.com/docs/hooks).

Implementation must verify the installed client's hook schema and run a disposable lifecycle
probe before marking native automation available. Do not assume the current chat is locally
orchestrated merely because it can access the local filesystem. Do not scrape private transcript
formats to identify lifecycle or discover ports.

| Surface | Planned integration |
| --- | --- |
| Supported local Codex | Render project `.codex/hooks.json`, keyed to a new confirmed `CODEX_HOOKS` flag; adapt real session/turn payloads. |
| Claude Code | Extend existing settings through additive merging; retain verification behavior; verify each event's current payload/output contract before wiring it. |
| Other/unsupported harness | Root instructions call begin/run/finish; supervisor and next-start recovery remain available. Native hook enforcement is explicitly unavailable. |
| CI | Render/contract/behavior tests only; no agent lifecycle daemon or Git checkout mutation in ordinary CI. |

Use one hook representation per Codex config layer. Preserve other hooks and permissions during
adoption/sync. Native hooks receive validated IDs; fallback clients get a generated internal ID
and a receipt the agent reuses during that thread. Do not invent a universal session environment
variable, reuse the ID of an exec cell as a thread ID, or generate a new owner for every command.

Routine Git refresh, managed launch, and exact owned-resource cleanup are authorized by the
project's lifecycle policy. Permission configuration should name the lifecycle entrypoint
narrowly rather than allow broad shell/kill commands. Existing sandbox and organization rules
still apply. Do not bypass native hook trust or silently weaken approvals to avoid a prompt.
Initial trust/configuration can require setup intervention; daily lifecycle actions should not.

## Files and responsibilities

The implementation ships these responsibilities through the templates; this document itself
does not activate hooks or create runtime state in the boilerplate checkout.

| File or area | Responsibility |
| --- | --- |
| `templates/scripts/session/cli.mjs` | Public begin/run/status/finish/sweep interface; validate inputs; compact structured output. |
| `templates/scripts/session/state.mjs` | Atomic registry, locks, canonical paths, schema, leases, Markdown projection. |
| `templates/scripts/session/git.mjs` | Read-only preflight, locked default-branch refresh, exception outcomes, isolated worktree setup. |
| `templates/scripts/session/supervisor.mjs` | Launch handshake, subprocess identity, live leases, termination, pending-cleanup recovery. |
| `templates/scripts/session/hooks.mjs` | Normalize harness events; sequence checks and cleanup; emit each harness's exact protocol. |
| `templates/.agents/skills/sweep/SKILL.md` | Automatic-use triggers; inspect/reconcile/cleanup procedure; ownership constraints; diagnostics. |
| `templates/docs/session-lifecycle.md` | Canonical policy, supported resources, exception behavior, setup/trust and recovery runbook. |
| Runtime `.agents/sessions.md` | Generated current resource view; ignored; zero bytes or absent at rest. |
| Pre-Git `.agents/.runtime/` | Local fallback registry; ignored; migrated when the project becomes a Git repository. |
| Root/lean/app instructions and local setup | Route to the policy; require startup and managed launch; require release before handoff. |
| Claude settings and new Codex hooks template | Harness wiring, gated by confirmed support; no competing standalone Stop cleanup hook. |
| Manifest and `scaffold.mjs` | Include lifecycle in both presets; executable scripts; Codex gating and lean allowlist. |
| `docs-check.mjs` and skill index | Recognize sweep as an owned skill; exclude the ephemeral view from authored-doc checks. |
| Detector, intake, adoption, doc-system and catalog references | Correct harness detection, compatibility claims, command recipes, ownership of runtime vs memory. |
| `test/session-*.test.mjs` plus existing variant/stop tests | Behavioral coverage, real temporary processes/repos, rendering and hook contract checks. |
| README and changelog | Describe shipped behavior and actual compatibility only once implementation is verified. |

Keep these as small cohesive modules; no framework, database, generic plugin system, background
queue, or dependency install is needed. Thread startup, resources, and harness protocols have
different failure modes; avoid putting all of them in the existing check script.

## Contracts and failure behavior

- Every command returns a schema version, outcome code, scope IDs, Git decision when relevant,
  and resource/recovery counts. Default human output stays brief; `--json` is machine-readable.
- Distinguish a safe preservation/offline outcome from corrupt state, launch failure, or an
  incomplete cleanup. Expected exceptions must not cause an infinite agent repair loop.
- Hooks translate CLI outcomes into the harness protocol; raw status text must not leak into
  JSON-only hook responses. Child output cannot corrupt protocol stdout.
- Locks cover read/modify/write and checkout mutation. Expired lock recovery requires validated
  owner identity; age alone does not authorize stealing a live lock. Lock contention is bounded.
- Shared-resource acquisition, finish, sweep, and retries are idempotent. Late callbacks carry
  turn/generation IDs so an old Stop/Interrupt cannot release a newer turn's resources.
- On filesystem/registry failure, stop launching new managed resources; preserve evidence for
  existing ones. On cleanup failure, keep the row with the reason and automatically retry at
  the next valid entry. No false `clean` output.
- Observability is an on-demand status plus bounded redacted receipts. Successful handoffs need
  at most one line such as `Session clean; no temporary resources remain.`

## Acceptance tests

Use isolated local bare remotes and ephemeral listeners; no external accounts or user processes.

1. A fresh clean checkout switches to main and receives a new remote commit exactly once.
   Further turns, compaction, and resume preserve subsequent feature work.
2. Dirty tracked/staged/untracked state, local-main ahead/diverged, feature commits, ongoing Git
   operations, explicit refs, missing remote/default, and offline/timeout cases preserve files
   and report distinct outcomes. Custom default branches work.
3. Two simultaneous threads cannot mutate one checkout underneath each other. Main checked
   out elsewhere selects the isolated fallback without forcing it; all later work uses that cwd.
4. A managed server that spawns a child listener is registered and fully stopped on finish;
   the active document becomes empty. Parent exit before child exit is covered.
5. A borrowed server and a second thread's server survive cleanup. A shared managed server
   stops only after the last lease is released. Wrong source/cwd/config prevents unsafe reuse.
6. PID reuse, boot change, a reused port, daemonized descendants, and unverifiable identity
   cannot kill an unrelated process or manufacture a successful cleanup.
7. Inject failures before registration, between pending and running, during registry writes,
   and after launch. A child cannot escape the launch handshake; recovery retains evidence.
8. Interrupt/end requests survive the callback time limit. Missing end events and owner death
   trigger supervisor cleanup; supervisor death is recovered on the next entry. Expired preview
   leases are swept; live foreground operations and explicit retained leases are respected.
9. Unchanged files and verification recursion guards do not skip cleanup. A failed validation
   remains failed after a successful sweep. Late/duplicate Stop callbacks are harmless.
10. Concurrent registry updates, corrupt schemas, malicious paths, and symlink redirection are
    handled without damaging work or clearing unresolved rows.
11. Full/lean, Node/Bun as claimed, GitHub/non-GitHub, and Claude/Codex/combined/no-native-hook
    variants emit valid files. Runtime views never enter Git or authored-doc validation.
12. Disposable installed-harness probes demonstrate startup, nested shell calls, hook retries,
    interruption, and handoff. Record the exact client/version and unsupported paths; docs
    alone do not count as tested host compatibility.

## Implementation sequence

1. **Registry and CLI contract:** state/locks/IDs, status view, empty-state behavior, and cleanup
   fixtures. Establish local process-identity support on macOS and Linux; report unsupported
   platforms explicitly rather than signaling from PID alone.
2. **Git guard:** begin intent, safety preflight, remote refresh, once-per-thread marker,
   checkout leases, and isolated fallback. Test against local repositories before hook wiring.
3. **Managed launch and sweep:** launch handshake, supervisor, process-tree/listener checks,
   reuse/borrowing, expiry, finish, crash recovery, and preserved failure rows.
4. **Instructions and sweep skill:** write the canonical runbook, route full/lean/app dev loops,
   add ignore rules, update memory ordering, and include all lifecycle files in both presets.
   Inventory/intent precedes Git mutation; remember restore remains non-mutating.
5. **Native adapters:** integrate existing Stop checks, add supported Codex/Claude events,
   narrow entrypoint permissions, feature detection, trust instructions, and protocol tests.
6. **Adoption/sync and release validation:** preserve existing configs and local edits; exercise
   generated variants and installed-host probes; update README/changelog and document exact
   guarantees. Run the repository test suite and `git diff --check`.

The smallest useful delivery is the complete Git guard plus managed process cleanup in both
presets. Exact-instance browser/container adapters may follow, but must be listed as unavailable
until implemented. Do not advertise universal app cleanup with only process-name matching.

## Assumptions and practical guarantee

The intended scope is this boilerplate and projects that explicitly adopt/sync it. Default
branch/remote come from each project's confirmed configuration. A completed handoff ends the
temporary resource lease even if the conversation remains open. User-owned services are allowed
to remain running; the zero-leak target concerns unnecessary resources created by the agent.

Under a supported, configured local harness, managed temporary resources are released at normal
handoff without a question. Interruption/owner-death cleanup uses the supervisor; supervisor
failure is repaired on the next entry. A genuinely unresolved ownership or permission failure
stays visible. An empty document means no recorded active leases or unresolved managed-resource
cleanup, not proof that the entire computer has no listeners.

## Implementation and verification

The generated runtime uses one atomic, versioned `state.json` registry beneath Git's common
directory, with short locks and serialized abandoned-lock recovery. Each managed service has
its own ephemeral supervisor and a registration handshake before application launch. The
generated `.agents/sessions.md` view is ignored and zero bytes when no active or unresolved
resources remain. The sweep skill, runbook, root/app instructions, and native adapters share
the same begin/run/finish/sweep commands.

Pre-Git state remains authoritative while its thread records exist, including across Git
initialization; linked worktrees locate it through the primary checkout. After those records
retire, new state uses Git's common directory. This avoids moving live supervisors' registry
paths during initialization. The initial adapters cover owned local process trees and borrowed
services. Browser contexts, arbitrary GUI apps, containers, and unobserved daemonized children
remain unsupported and are documented as such.

Behavioral tests use local bare Git remotes and real ephemeral listeners. They cover fresh
and custom default branches, preservation exceptions, missing local default branches, concurrent
inspection worktrees, shared/borrowed resources, process identity and supervisor recovery,
retention, foreground liveness, lock recovery, hook payloads, and empty-document cleanup. The
full suite for the isolated PR contents passed all 65 tests under Node 22.21.1 and Bun 1.4.2
on macOS. The sweep skill passed
the Skill Creator validator; generated variants, syntax checks, documentation budgets, and
`git diff --check` passed. Fixture teardown verifies that managed resource records are empty.

The installed Codex CLI 0.162.1 schema was generated and checked for the configured lifecycle
events; Claude Code 2.1.299 is installed. Native adapters were tested with synthetic protocol
payloads. Actual event dispatch inside an authenticated native model conversation and Linux
process inspection have not been exercised locally. Native hook trust remains required; the
implementation does not bypass it or claim that cloud hosts execute local hooks.

This change does not publish a release, install global hooks, self-adopt the generated runtime
in this template repository, or change other apps. Existing projects receive it through the
normal adoption/sync flow, with Codex hooks enabled only when supported and configured.
