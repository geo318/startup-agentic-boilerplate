import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { drive, type Task } from "../src/drive.ts";
import { sha256 } from "../src/hash.ts";
import { MockProvider } from "../src/provider.ts";
import { type Policy, Run } from "../src/run.ts";

const task: Task = { goal: "make value.txt say good", acceptance: ["check.mjs exits 0"], files: ["value.txt"] };
function setup(tokens = 40_000) {
  const base = mkdtempSync(join(tmpdir(), "drive-"));
  const ws = join(base, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "value.txt"), "bad");
  writeFileSync(
    join(ws, "check.mjs"),
    `import {readFileSync} from "node:fs"; console.log("tests 1"); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`,
  );
  const policy: Policy = {
    workspace: ws,
    stateDir: join(base, "state"),
    protectedPaths: ["check.mjs"],
    riskTier: "R1",
    egress: "local-only",

    gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 5000, discover: { regex: "tests (\\d+)", min: 1 } }],
    requiredGates: ["unit"],
    limits: { aggregateTokens: tokens, toolActions: 12, semanticRepairs: 1 },
  };
  const run = new Run(policy);
  run.start();
  return { run, ws };
}
const edit = JSON.stringify({
  id: "1",
  kind: "edit",
  edits: [{ kind: "replace", path: "value.txt", expectHash: sha256("bad"), find: "bad", replace: "good" }],
});

test("accepted path: mock worker edits, finishes, controller verifies, human accepts", async () => {
  const { run, ws } = setup();
  const p = new MockProvider([
    { content: edit, usage: { input: 300, output: 60 } },
    { content: '{"id":"2","kind":"finish"}', usage: { input: 320, output: 10 } },
  ]);
  assert.equal(await drive(run, p, ws, task), 2);
  assert.equal(run.state, "AWAITING_ACCEPTANCE");
  assert.equal(run.ledger.tokens, 690); // reservations settled to measured usage
  run.accept("operator");
  assert.equal(run.state, "ACCEPTED");
});

test("safely blocked path: worker reports blocked, nothing changed", async () => {
  const { run, ws } = setup();
  await drive(run, new MockProvider(['{"id":"1","kind":"blocked","reason":"insufficient context"}']), ws, task);
  assert.equal(run.state, "BLOCKED");
  assert.equal(run.evidence, undefined);
});

test("invalid / truncated output is never executed; repeated → BLOCKED", async () => {
  const { run, ws } = setup();
  await drive(run, new MockProvider(["not json", { content: edit, finishReason: "length" }]), ws, task);
  assert.equal(run.state, "BLOCKED");
});

test("unknown usage stays unknown and is charged at the reservation", async () => {
  const { run, ws } = setup();
  await drive(
    run,
    new MockProvider([
      { content: '{"id":"1","kind":"finish"}', usage: null },
      '{"id":"2","kind":"blocked","reason":"x"}',
    ]),
    ws,
    task,
  );
  assert.equal(run.ledger.unknownUsageCalls, 1);
});

test("token budget too small for one call → ESCALATED before any model call", async () => {
  const { run, ws } = setup(100);
  const p = new MockProvider([edit]);
  await drive(run, p, ws, task);
  assert.equal(run.state, "ESCALATED");
  assert.equal(p.calls.length, 0);
});

test("a model cannot self-accept through the driver", async () => {
  const { run, ws } = setup();
  await drive(run, new MockProvider(['{"id":"1","kind":"accept"}', '{"id":"2","kind":"accept"}']), ws, task, 2);
  assert.notEqual(run.state, "ACCEPTED");
});

test("repeated request for missing material → NEEDS_INPUT, not budget burn", async () => {
  const { run, ws } = setup();
  const read = '{"id":"x","kind":"read","path":"docs/spec.md"}';
  const p = new MockProvider([read, read, read, read]);
  await drive(run, p, ws, task);
  assert.equal(run.state, "NEEDS_INPUT");
  assert.equal(p.calls.length, 2);
});

test("re-reading an unchanged file is nudged once then stops (no budget burn)", async () => {
  const { run, ws } = setup();
  const read = '{"id":"x","kind":"read","path":"value.txt"}';
  const p = new MockProvider([read, read, read, read, read]);
  await drive(run, p, ws, task);
  assert.equal(run.state, "ESCALATED");
  assert.equal(p.calls.length, 3);
  assert.match(p.calls[2]!.prompt, /gives no new information/);
});

test("approved plan text is included in the worker prompt", async () => {
  const { run, ws } = setup();
  const p = new MockProvider(['{"id":"1","kind":"blocked","reason":"x"}']);
  await drive(run, p, ws, { ...task, plan: "STEP: change bad to good" });
  assert.match(p.calls[0]!.prompt, /APPROVED PLAN[\s\S]*STEP: change bad to good/);
});
