# FP-602 benchmark repairs

## Preparation guard

`preparation_guard.py` provides an offline-tested launch guard for a separately authorized
preparation phase. It reads the exact timestamp of a user `response_item`, not a nonexistent
`user_message` event, and subtracts the preceding settled cumulative token receipt. Cached
input is part of input and is never added twice. Missing accounting, rollback, malformed
settled records, exhausted wall/monotonic deadlines and insufficient reserved headroom stop
the phase. A partial final JSONL record is ignored until it settles. Stops are latched and
an existing guard directory cannot be initialized again.

Initialize a new guard with the actual native session file and exact user-message timestamp:

```sh
rtk python3 scripts/fp602-benchmark/preparation_guard.py /new/experiment/preparation-guard \
  --session /absolute/session.jsonl --boundary 'EXACT-ISO-TIMESTAMP'
```

Before another model call, use `--reserve N` with a conservative aggregate-token allowance.
Separate qualification/Jev native receipts are passed with repeated `--receipt` arguments;
the caller must supply every separate session once on every check. The tool cannot discover
omitted usage. Controller usage must not also be supplied as a separate receipt. Receipts
must contain reliable native counters, not estimates or invented zeroes.

`--run` supervises an explicit subprocess and terminates its process group if a check fails.
Qualification adapters must expose valid usage receipts immediately; missing receipts fail
closed. It does not interrupt the active chat generating its next turn, prevent in-flight
overshoot, or automatically integrate into `run-benchmark.py`. The runner-owned quick-pilot path below
uses its own subprocess supervision; a live comparison remains unverified.
Reporting after a stop is separate overhead and must remain visible. Do not reset a stopped
guard to resume the same preparation. No live pilot was launched to validate this repair.

Offline regression command:

```sh
rtk python3 -m unittest discover -s scripts/fp602-benchmark -p 'test_preparation_guard.py'
```

This is a corrected fork of the runner retained in `fp-602-benchmark-2026-10-02`.
The original report, scripts, frozen configuration, attempts and candidate snapshots are unchanged.
These corrections are for a **new experiment**, not replacement results for the frozen run.

## Corrected defects

- The broker obtains its exchange directory from `agentic handoff-path`. It does not guess from the legacy profile `dir`, scan other projects, or need a compatibility symlink. Partial packet writes are retried; responses are published atomically.
- Grading receives a separate native-token allowance regardless of workflow overshoot: 200,000 by default in legacy mode and 25,000 in quick-pilot mode. Workflow and grading settings are retained separately. Cached input continues to count toward both ceilings.
- Grading clones the frozen Git history into a separate workspace, overlays the actual candidate (including deletions), and installs its frozen lockfile before checks. Preparation errors remain infrastructure failures. Native Codex also receives `--skip-git-repo-check`, which supports source-only directories.
- The original candidate is fingerprinted and preserved. Check-generated `.fallow/`, `temp/playwright/`, and `apps/web/next-env.d.ts` changes are recorded in the grading workspace; other source mutations still reject correctness. A `.git` pointer is metadata, not a product edit. Failed or missing required gates cannot be overridden by a model's PASS.
- The watchdog uses both UTC and monotonic deadlines. It catches a suspension/forward-clock gap on the next poll, and a backward wall-clock change cannot extend the monotonic deadline. It cannot execute while the host is suspended or prevent in-flight token overshoot.
- Native sessions that finish before the first poll are still discovered for final usage accounting. Commands check limits before launching. Unmeasured human time remains `null`.

## What the token failures establish

The original nine workers reached the 1,000,000 aggregate-token limit. Their coordinator sessions used about 0.82–1.09 million tokens, including about 0.74–0.98 million cached-input tokens, but produced only about 3,700–9,000 output tokens. Each completed managed qualification additionally used about 174,000–188,000 tokens before the coordinator began. Managed candidates had no product edits.

This is evidence of insufficient room for setup, discovery and implementation under that protocol. It is not evidence that a particular larger allowance guarantees completion. Legacy mode retains the default 20-minute/1,000,000 workflow limits; quick-pilot mode uses the smaller limits documented below. Both require fresh qualification and the same grading criteria. Each new experiment explicitly selects and freezes its model profile for both arms. It does not redefine cached tokens or silently increase spending. Before another five-pair experiment, run a separately identified feasibility pilot and freeze a practical scope/context strategy and budget for both arms. A live rerun is not part of these offline repairs; successful FP-602 completion and any managed efficiency gain remain unverified.

## Validation

Run from the boilerplate root:

```sh
rtk python3 -m unittest discover -s scripts/fp602-benchmark -p 'test_*.py'
rtk npm run verify
```

The suite uses temporary fixtures, synthetic model replies, and the real runtime CLI for all six qualification exchanges. No live model calls or historical evidence writes occur. Python 3, Node and RTK must be installed.

## A future run

Prepare a **new** data directory with the original `seed.git`, `baseline/`, `worker-ticket.md`, `private-grader/grading-protocol.md`, and a newly frozen `frozen-configuration.json`. The seed must contain consumer commit `e406ab40c00566a0f73f2e751bd0df3b2668375a`. Record this fork/current runtime as the new harness, not the old runtime pin. Keep historical `attempts/` and `results.json` out of the new directory. The runner refuses a directory already containing either.

The runner uses this checkout's runtime, the installed `node`, and an explicit `native-profile.json`; each consumer worktree is pinned to that runtime during setup. Install runtime dependencies first. Only after the new protocol and live-run budget are settled:

```sh
BENCHMARK_ROOT=/absolute/path/to/new-experiment rtk python3 scripts/fp602-benchmark/run-benchmark.py --preflight
BENCHMARK_ROOT=/absolute/path/to/new-experiment rtk python3 scripts/fp602-benchmark/run-benchmark.py --execute
```

The original analysis/report scripts assume the old grading layout; do not use them to silently rewrite the old report with new results. Review new `grading.json` fields and phase settings when preparing a new report. Billed cost remains unknown without a provider ledger.

Native CLI option reference: https://developers.openai.com/codex/cli/reference/

## Native model profiles

Create `native-profile.json` in the **new experiment's data directory**. No model or provider is selected by default.
The runner freezes it as `native-profile.frozen.json` before setup and rejects later changes. The qualification label
includes a hash of the profile, so a different model, provider or settings cannot inherit the earlier qualification.
The frozen profile applies to workers, qualification and independent graders for both arms.

For Codex, use the exact model ID and provider key from your installed CLI configuration:

```json
{
  "kind": "codex-cli",
  "model": "YOUR-MODEL-ID",
  "provider": "YOUR-CODEX-PROVIDER-KEY",
  "reasoning_effort": "high"
}
```

`reasoning_effort` is optional and must be supported by your selected model/CLI. `namespace_headers: true` optionally
adds the Headroom attempt-isolation headers to the selected provider; no Headroom dependency is otherwise assumed.
To reproduce the earlier model selection, explicitly choose the model/provider/effort recorded in the original frozen
configuration. This does not make the corrected experiment a replacement for the historical run.

For another native CLI, supply a trusted local bridge command:

```json
{
  "kind": "command",
  "model": "YOUR-MODEL-ID",
  "provider": "YOUR-NATIVE-CLI",
  "argv": ["rtk", "python3", "/absolute/path/to/bridge.py", "{request}"]
}
```

The argv array runs without a shell. `{request}` is replaced with an absolute JSON request path. The request contains
`model`, `provider`, optional `reasoning_effort`, `project`, `prompt`, `readonly`, `session_namespace`, `schema`,
`reply_path`, and `usage_path`. The bridge must start a fresh native session with those settings, enforce the read-only
mode when requested, isolate session/memory state by namespace, write the final reply text, and publish native usage
atomically as it settles. It must not substitute models, invent counters or call paid APIs. The benchmark retains its
subscription-only environment (API-key variables are removed). This bridge must be implemented for the chosen CLI;
passing a bare CLI executable does not translate its flags or accounting automatically.

Usage receipt format:

```json
{
  "tokens": {"input_tokens": 100, "cached_input_tokens": 80, "output_tokens": 20, "total_tokens": 120},
  "actual_billed_usd": null
}
```

Counters are cumulative for **this one session**, not the entire attempt. Cached input is a subset of input; total is
input plus output. Optional native `rate_limits` and `turn_context` evidence can accompany the receipt. Missing or invalid
command-adapter usage stops the attempt. The shared watchdog includes these counters along with every other call;
in-flight overshoot remains possible. Stdout/stderr and the request/receipt files are retained as evidence.


## Comparing execution from an agreed contract

The optional `"workflow_protocol": "shared-contract-v1"` in `frozen-configuration.json` removes the outer model
coordinator from arm B. Python drives `task start`, exact-plan approval when authorized, `task run`, and export.
The runtime still executes required gates and independent review. Arm A receives the **same contract, concrete plan,
context-file list and write scope** in its normal development prompt. The default `discovery-v1` keeps the original
coordinator path. These are different experiments; do not combine their results.

Prepare `shared-contract.json` beside the native profile before starting the new experiment:

```json
{
  "contract": {
    "schemaVersion": 1,
    "id": "your-task",
    "goal": "Your complete task goal",
    "acceptance": ["Your complete acceptance criteria"],
    "files": ["path/to/context.ts"],
    "scope": ["path/to/context.ts"],
    "riskTier": "R2",
    "budget": "standard",
    "plan": "The concrete, agreed implementation plan"
  },
  "approved_plan_sha256": null,
  "accept_when_verified": false,
  "preparation_native_tokens": null
}
```

Use the real task's full requirements, risk tier and context strategy. `approved_plan_sha256` is the SHA-256 of the
exact UTF-8 `contract.plan`, recorded **after operator approval**. Null pauses R2/R3 without product edits. The runner
compares the runtime's saved plan text and hash before issuing approval; it cannot approve a generated replacement.
`accept_when_verified: true` explicitly authorizes benchmark acceptance after gates and review. False leaves the
candidate awaiting acceptance, still eligible for independent grading. Neither mode merges or publishes changes.
The runner freezes this file and rejects subsequent changes; runtime contract validation remains authoritative.

Record measured model tokens spent preparing the shared contract in `preparation_native_tokens`; use null when unknown,
including unmeasured prior-chat work. This value is carried into each result separately from attempt usage. Charge the
same preparation cost to each arm when reporting per-task totals (or state an explicit amortization); do not silently
count it as zero. If unknown, report only execution-phase comparisons, not end-to-end savings. Fresh qualification costs
remain in managed workflow totals in legacy mode; quick-pilot mode reports them separately and requires adding them
to B's cold-start total. Qualification reuse in normal operation is a separate warm-start experiment.

## Offline overhead evidence

The runtime regression `batch reduces repeated request bytes and calls for the same verified edit` compares two
sequential context reads with one `read_many`, followed by the same verified edit. It prints aggregate UTF-8 bytes of
system + prompt + schema and model-call counts. Run it with:

```sh
rtk node --test --test-name-pattern='batch reduces' packages/agent-runtime/test/drive.test.ts
```

The first measured fixture result is 3 → 2 worker calls and 7,007 → 4,652 request bytes (about 34% fewer). This is a
synthetic within-runtime overhead comparison, **not** token usage, provider billing, or proof of a managed advantage
over unmanaged coding. The real-controller replay test also verifies direct start → approved plan → worker → reviewer
→ acceptance/export with no coordinator or architect call. Live paired runs must establish correctness and net savings;
no such result is claimed by these offline checks.


## Quick pilot: runner-owned setup and qualification

The October 3 failed pilot spent 315,354 preparation tokens (288,896 cached input) in the
interactive coordinator before launching either arm. Its copied runner was still unmodified.
A late transcript scan failed because it expected `user_message` instead of `response_item`.
Checking either format retrospectively cannot stop an active chat or undo that spend.

The runner now has a separate path that does not scan the surrounding chat or ask a model to
rewrite the benchmark. In a **new prepared experiment directory**, set:

```json
{
  "mode": "quick-pilot-v1",
  "workflow_protocol": "shared-contract-v1",
  "trial_order": {"paired_orders": [["A", "B"]]},
  "jev": {"configured": "disabled", "actual": "inactive"}
}
```

Randomize the single A/B order before freezing it. This mode permits exactly one pair. Defaults
are 300 seconds/200,000 native tokens for supervised qualification, 600 seconds/250,000 tokens
per workflow, and 180 seconds/25,000 tokens per independent grade. A `limits` object can lower
these six values, but cannot exceed them. The resolved configuration is saved once in
`execution-settings.json` and passed to the runner/grader; limits are not merely prompt text.

`--preflight` is read-only apart from temporary validation files: it makes **zero model calls**,
checks inputs/model configuration/contract schema/explicit shared-plan approval and refuses
existing experiment evidence. Run it directly from this tooling checkout; copying the runner
breaks its runtime location and is refused. Missing files are reported before qualification.
`--execute` is required to authorize live inference; the bare command never launches a run.
This does not create a plan or missing experiment inputs. Preparing those in a chat still costs
tokens and must be accounted for separately; unknown planning usage remains unknown, never zero.

After successful preflight, Python creates `preparation/00P`, installs its watchdog settings
**before** setup, and supervises each qualification subprocess. No interactive coordinator is
inside this phase. Missing native counters refuse continuation. A stopped preparation retains
its receipt and launches neither arm; it cannot be reset by reusing the directory. Successful
qualification is copied only to B for the same frozen native profile. Its tokens/time are
reported separately on B and must be included in cold-start comparisons. Shared plan preparation
cost remains separate and symmetric. The workflow/grading receipt totals cover each attempt;
add B's `qualification_native_tokens` for its complete cold-start total.

The independent `preparation_guard.py` remains useful for inspecting/supervising explicitly
provided external sessions. This runner does not use that tool to police the active chat.
Both watchdog approaches observe settled telemetry; an in-flight request can overshoot before
it reports usage, and no script can interrupt a suspended host. These are not provider-enforced
hard token caps. No additional live pilot has been run to validate these repairs.

Jev is **inactive** in this runner. Preflight rejects an active-Jev treatment claim rather than
silently switching it off. A real Jev-on comparison still requires calibrated consumer wiring.
