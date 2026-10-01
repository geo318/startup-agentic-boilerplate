import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { drive } from "../src/drive.ts";
import { sha256 } from "../src/hash.ts";
import { MockProvider } from "../src/provider.ts";
import { type Policy, Run } from "../src/run.ts";

function setup(over: Partial<Policy> = {}, check?: string) {
  const base = mkdtempSync(join(tmpdir(), "rs-"));
  const ws = join(base, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "value.txt"), "bad");
  writeFileSync(join(ws, "check.mjs"), check ?? `import {readFileSync} from "node:fs"; console.log("tests 1"); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`);
  const policy: Policy = {
    workspace: ws, stateDir: join(base, "state"), protectedPaths: ["check.mjs"], riskTier: "R1", egress: "local-only", isolation: "none",
    gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 8000, discover: { regex: "tests (\\d+)", min: 1 } }],
    requiredGates: ["unit"], limits: { aggregateTokens: 50_000, toolActions: 12, semanticRepairs: 1 }, ...over,
  };
  return { policy, ws, base };
}
const fix = (id: string) => ({ id, kind: "edit", edits: [{ kind: "replace", path: "value.txt", expectHash: sha256("bad"), find: "bad", replace: "good" }] });
// "crash": drop the process-local Run without a clean shutdown, except releasing the lock the dead process would have freed
const crash = (run: Run) => run.close();

test("resume: a crashed run continues from recorded state; seen ids and ledger survive", async () => {
  const { policy } = setup();
  const a = new Run(policy);
  a.start();
  await a.handle(fix("a1"));
  const used = a.ledger.actions;
  crash(a);
  const b = new Run(policy);
  b.resume();
  assert.equal(b.state, "IMPLEMENTING");
  assert.equal(b.ledger.actions, used);
  assert.equal((await b.handle(fix("a1"))).ok, false); // replayed action id is refused, not re-applied
  assert.equal((await b.handle({ id: "a2", kind: "finish" })).ok, true);
  assert.equal(b.state, "AWAITING_ACCEPTANCE");
  b.accept("operator");
  assert.equal(b.state, "ACCEPTED");
});

test("resume after verified: evidence reloaded, acceptance still bound to the candidate", async () => {
  const { policy, ws } = setup();
  const a = new Run(policy);
  a.start();
  await a.handle(fix("a1"));
  await a.handle({ id: "a2", kind: "finish" });
  crash(a);
  const b = new Run(policy);
  b.resume();
  assert.equal(b.state, "AWAITING_ACCEPTANCE");
  assert.ok(b.evidence);
  writeFileSync(join(ws, "value.txt"), "good + tampered while suspended");
  b.close();
  const c = new Run(policy);
  c.resume();
  assert.equal(c.state, "BLOCKED"); // workspace differs from the recorded candidate
});

test("resume refuses when the policy changed (e.g. gates swapped)", async () => {
  const { policy } = setup();
  const a = new Run(policy);
  a.start();
  crash(a);
  const b = new Run({ ...policy, requiredGates: [] });
  b.resume();
  assert.equal(b.state, "BLOCKED");
});

test("resume: in-flight billable call is charged at its reservation and flagged uncertain", async () => {
  const { policy } = setup();
  const a = new Run(policy);
  a.start();
  a.ledger.reserve(2000);
  a.beginCall(2000);
  crash(a); // died before the provider answered
  const b = new Run(policy);
  b.resume();
  assert.equal(b.uncertainBilling, true);
  assert.equal(b.ledger.tokens, 2000);
  assert.equal(b.ledger.unknownUsageCalls, 1);
});

test("resume: a crash mid-verification re-runs the gates; no billable call is replayed", async () => {
  const { policy } = setup();
  const a = new Run(policy);
  a.start();
  await a.handle(fix("a1"));
  await a.handle({ id: "gate-warm", kind: "run_gate", gateId: "unit" });
  // simulate dying right after entering VERIFYING
  (a as any).state = "VERIFYING";
  (a as any)["#log"];
  crash(a);
  // write the transition the dead process would have logged
  const { EventLog } = await import("../src/events.ts");
  const log = new EventLog(join(policy.stateDir, "events.jsonl")).open();
  log.append("state", { from: "IMPLEMENTING", to: "VERIFYING", ledger: a.ledger.snapshot() });
  log.close();
  const b = new Run(policy);
  b.resume();
  assert.equal(b.state, "VERIFYING");
  assert.equal((await b.reverify()).ok, true);
  assert.equal(b.state, "AWAITING_ACCEPTANCE");
});

test("resume of a finished run stays finished", async () => {
  const { policy } = setup();
  const a = new Run(policy);
  a.start();
  await a.handle({ id: "a1", kind: "blocked", reason: "x" });
  crash(a);
  const b = new Run(policy);
  b.resume();
  assert.equal(b.state, "BLOCKED");
  assert.equal((await b.handle({ id: "a2", kind: "finish" })).ok, false);
});

test("cancel kills a running gate and its descendants", async () => {
  const marker = (ws: string) => join(ws, "survivor.txt");
  const { policy, ws } = setup({}, `import {spawn} from "node:child_process";
spawn(process.execPath, ["-e", "setTimeout(()=>require('fs').writeFileSync('survivor.txt','alive'),1500)"], {stdio:"ignore"});
console.log("tests 1"); setTimeout(()=>{}, 20000)`);
  const run = new Run(policy);
  run.start();
  const pending = run.handle({ id: "g1", kind: "finish" });
  await new Promise((r) => setTimeout(r, 500));
  run.cancel();
  await pending;
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(run.state, "CANCELLED");
  assert.equal(existsSync(marker(ws)), false); // the grandchild never wrote its file
});

test("cancel aborts an in-flight provider call and stops the driver", async () => {
  const { policy, ws } = setup();
  const run = new Run(policy);
  run.start();
  let aborted = false;
  const slow = {
    id: "slow", hosted: false,
    generate: (req: { signal?: AbortSignal }) => new Promise<never>((_, rej) => req.signal?.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); })),
  } as any;
  const d = drive(run, slow, ws, { goal: "g", acceptance: [], files: ["value.txt"] }).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  run.cancel();
  await d;
  assert.equal(aborted, true);
  assert.equal(run.state, "CANCELLED");
});
