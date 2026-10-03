import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAction } from "../src/actions.ts";
import { drive, type Task } from "../src/drive.ts";
import { sha256 } from "../src/hash.ts";
import { MockProvider } from "../src/provider.ts";
import { type Policy, Run } from "../src/run.ts";

const task: Task = { goal: "make value.txt say good", acceptance: ["check.mjs exits 0"], files: ["value.txt"] };
function setup(tokens = 40_000, files: Record<string, string> = {}) {
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
  for (const [path, content] of Object.entries(files)) writeFileSync(join(ws, path), content);
  const run = new Run(policy);
  run.start();
  return { run, ws, policy };
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

test("final edit can request controller verification without a second model call", async () => {
  const { run, ws } = setup();
  const p = new MockProvider([edit.replace('"kind":"edit"', '"kind":"edit_and_finish"')]);
  await drive(run, p, ws, task);
  assert.equal(p.calls.length, 1);
  assert.equal(run.state, "AWAITING_ACCEPTANCE");
  run.close();
});

const batch = (paths: string[]) => JSON.stringify({ id: "batch", kind: "read_many", paths });

test("batch read validation is closed and bounded", () => {
  for (const paths of [[], [""], [1], ["x", "x"], Array.from({ length: 21 }, (_, i) => `${i}`), "x"]) {
    assert.throws(() => parseAction({ id: "r", kind: "read_many", paths }), /read_many/);
  }
  assert.throws(() => parseAction({ id: "r", kind: "read_many", paths: ["x"], path: "x" }), /unknown field/);
  assert.equal(parseAction(JSON.parse(batch(["one", "two"]))).kind, "read_many");
});

test("batch rejects missing, unsafe and symlink paths without returning partial contents", async () => {
  const { run, ws } = setup();
  symlinkSync(join(ws, ".."), join(ws, "outside"));
  for (const path of ["missing.txt", "../value.txt", "/etc/passwd", "outside/state/events.jsonl"]) {
    const out = await run.handle({ id: path, kind: "read_many", paths: ["value.txt", path] });
    assert.equal(out.ok, false, path);
    assert.equal(out.data, undefined);
    assert.equal(run.contextReads.size, 0);
  }
  run.close();
});

test("batch reduces repeated request bytes and calls for the same verified edit", async (t) => {
  const results: Array<{ calls: number; bytes: number }> = [];
  for (const batched of [false, true]) {
    const { run, ws } = setup();
    writeFileSync(join(ws, "first.txt"), "first specification");
    writeFileSync(join(ws, "second.txt"), "second specification");
    const reads = batched
      ? [batch(["first.txt", "second.txt"])]
      : [
          JSON.stringify({ id: "r", kind: "read", path: "first.txt" }),
          JSON.stringify({ id: "s", kind: "read", path: "second.txt" }),
        ];
    const p = new MockProvider([...reads, edit.replace('"kind":"edit"', '"kind":"edit_and_finish"')]);
    await drive(run, p, ws, task);
    assert.equal(run.state, "AWAITING_ACCEPTANCE");
    assert.equal(readFileSync(join(ws, "value.txt"), "utf8"), "good");
    assert.match(p.calls.at(-1)!.prompt, /first specification/);
    assert.match(p.calls.at(-1)!.prompt, /second specification/);
    assert.match(p.calls.at(-1)!.prompt, new RegExp(sha256("second specification")));
    results.push({
      calls: p.calls.length,
      bytes: p.calls.reduce((n, r) => n + Buffer.byteLength(r.system + r.prompt + JSON.stringify(r.schema)), 0),
    });
    run.close();
  }
  assert.equal(results[0]!.calls, 3);
  assert.equal(results[1]!.calls, 2);
  assert.ok(results[1]!.bytes < results[0]!.bytes);
  t.diagnostic(
    `offline request overhead (not provider tokens): ${JSON.stringify({ sequential: results[0], batched: results[1] })}`,
  );
});

test("batch contents survive a driver interruption and are compiled on resume", async () => {
  const { run, ws, policy } = setup(40_000, { "spec.txt": "persisted specification" });
  const p = new MockProvider([batch(["value.txt", "spec.txt"])]);
  const record = run.record.bind(run);
  run.record = (type, data) => {
    record(type, data);
    if (type === "context_read" && (data as { path: string }).path === "spec.txt") throw new Error("interrupted");
  };
  await assert.rejects(drive(run, p, ws, task), /interrupted/);
  run.close();
  const resumed = new Run(policy);
  resumed.resume();
  assert.deepEqual([...resumed.contextReads], ["value.txt", "spec.txt"]);
  const next = new MockProvider([edit.replace('"kind":"edit"', '"kind":"edit_and_finish"')]);
  await drive(resumed, next, ws, task);
  assert.match(next.calls[0]!.prompt, /persisted specification/);
  assert.equal(resumed.state, "AWAITING_ACCEPTANCE");
  resumed.close();
});

test("batch reads obey context limit and repeated missing/no-progress guards", async () => {
  for (const mode of ["oversize", "missing", "repeat"]) {
    const { run, ws } = setup();
    writeFileSync(join(ws, "large.txt"), "x".repeat(20_000));
    const action = batch(
      mode === "oversize" ? ["large.txt"] : mode === "missing" ? ["value.txt", "missing.txt"] : ["value.txt"],
    );
    const p = new MockProvider([action, action, action]);
    await drive(run, p, ws, task);
    assert.equal(run.state, mode === "oversize" ? "BLOCKED" : mode === "missing" ? "NEEDS_INPUT" : "ESCALATED");
    assert.equal(p.calls.length, mode === "oversize" ? 1 : mode === "missing" ? 2 : 3);
    if (mode === "missing") assert.equal(run.contextReads.size, 0);
    run.close();
  }
});
