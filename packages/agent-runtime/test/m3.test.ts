import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatCompletionsProvider } from "../src/chat.ts";
import { ManualProvider } from "../src/manual.ts";
import { MockProvider } from "../src/provider.ts";
import { probeActionProtocol, QualStore, selectProfile } from "../src/qualify.ts";
import { Ledger } from "../src/budget.ts";
import { riskFloor } from "../src/risk.ts";
import { architect, review, RoleFailed, type Finding } from "../src/roles.ts";
import { type Policy, Run } from "../src/run.ts";
import { Serial, serialized } from "../src/serial.ts";
import { sha256 } from "../src/hash.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "m3-"));

// ---------- transports ----------
test("manual exchange: packet written, reply file read; no reply → error", async () => {
  const dir = tmp();
  const p = new ManualProvider(dir, "codex-by-hand", 1500);
  setTimeout(() => writeFileSync(join(dir, "response-1.txt"), '{"id":"1","kind":"finish"}'), 300);
  const r = await p.generate({ system: "S", prompt: "P", maxOutputTokens: 10, schema: { type: "object" } });
  assert.equal(r.content, '{"id":"1","kind":"finish"}');
  assert.equal(r.usage, null);
  assert.equal(p.hosted, true);
  const quiet = await new ManualProvider(tmp(), "x", 300).generate({ system: "", prompt: "", maxOutputTokens: 1 });
  assert.equal(quiet.finishReason, "error");
});

async function fakeChat(reply: (b: any, h: any) => any) {
  const seen: Array<{ body: any; headers: any }> = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ body, headers: req.headers });
      const r = reply(body, req.headers);
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r.body ?? r));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/v1`, seen, close: () => srv.close() };
}
const chatProfile = (baseUrl: string, over = {}) => ({ baseUrl, model: "m1", hosted: false, supportsJsonSchema: true, temperature: 0, timeoutMs: 2000, ...over });

test("chat-completions: schema, usage, key from env only (never in body), unsupported schema omitted", async () => {
  process.env.TEST_CHAT_KEY = "sekret";
  const f = await fakeChat(() => ({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  const p = new ChatCompletionsProvider(chatProfile(f.baseUrl, { apiKeyEnv: "TEST_CHAT_KEY" }));
  const r = await p.generate({ system: "s", prompt: "u", maxOutputTokens: 50, schema: { type: "object" } });
  assert.deepEqual(r.usage, { input: 7, output: 3 });
  assert.equal(f.seen[0]!.headers.authorization, "Bearer sekret");
  assert.ok(!JSON.stringify(f.seen[0]!.body).includes("sekret"));
  assert.equal(f.seen[0]!.body.response_format.type, "json_schema");
  assert.equal(f.seen[0]!.body.max_tokens, 50);
  await new ChatCompletionsProvider(chatProfile(f.baseUrl, { supportsJsonSchema: false })).generate({ system: "", prompt: "", maxOutputTokens: 5, schema: {} });
  assert.equal(f.seen[1]!.body.response_format, undefined);
  f.close();
});

test("chat-completions: length, http error, missing usage are handled explicitly", async () => {
  for (const [reply, finish] of [[{ choices: [{ message: { content: "{" }, finish_reason: "length" }] }, "length"], [{ status: 500, body: {} }, "error"]] as const) {
    const f = await fakeChat(() => reply);
    assert.equal((await new ChatCompletionsProvider(chatProfile(f.baseUrl)).generate({ system: "", prompt: "", maxOutputTokens: 5 })).finishReason, finish);
    f.close();
  }
  const f = await fakeChat(() => ({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }));
  assert.equal((await new ChatCompletionsProvider(chatProfile(f.baseUrl)).generate({ system: "", prompt: "", maxOutputTokens: 5 })).usage, null);
  f.close();
});

test("serial: concurrent local calls never overlap", async () => {
  let active = 0, peak = 0;
  const slow = { id: "local", hosted: false, generate: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return { content: "{}", finishReason: "stop" as const, usage: null, latencyMs: 0 }; } };
  const lock = new Serial();
  const a = serialized(slow, lock), b = serialized(slow, lock);
  await Promise.all([a.generate({ system: "", prompt: "", maxOutputTokens: 1 }), b.generate({ system: "", prompt: "", maxOutputTokens: 1 }), a.generate({ system: "", prompt: "", maxOutputTokens: 1 })]);
  assert.equal(peak, 1);
});

// ---------- qualification and routing ----------
const goodWorker = () => {
  const h = sha256("alpha");
  return new MockProvider(['{"id":"p1","kind":"finish"}', JSON.stringify({ id: "p2", kind: "edit", edits: [{ kind: "replace", path: "f.txt", expectHash: h, find: "alpha", replace: "beta" }] })]);
};

test("qualification needs every repeated attempt: one flaky answer in three fails the probe", async () => {
  const h = sha256("alpha");
  const edit = JSON.stringify({ id: "p2", kind: "edit", edits: [{ kind: "replace", path: "f.txt", expectHash: h, find: "alpha", replace: "beta" }] });
  const stray = JSON.stringify({ id: "p2", kind: "edit", path: "f.txt", edits: [{ kind: "replace", path: "f.txt", expectHash: h, find: "alpha", replace: "beta" }] });
  const fin = '{"id":"p1","kind":"finish"}';
  const store = new QualStore(join(tmp(), "q.json"));
  const steady = Object.assign(new MockProvider([fin, edit, fin, edit, fin, edit]), { id: "mock/steady" });
  assert.equal((await probeActionProtocol(steady, store)).passed, true);
  const flaky = Object.assign(new MockProvider([fin, edit, fin, stray, stray, fin, edit]), { id: "mock/flaky" });
  const q = await probeActionProtocol(flaky, store);
  assert.equal(q.passed, false);
  assert.equal(q.detail.patch_apply, "2/3"); // one attempt failed even after its retry
});

test("a probe attempt may recover once from a rejected reply; first-try quality is still recorded", async () => {
  const h = sha256("alpha");
  const edit = JSON.stringify({ id: "p2", kind: "edit", edits: [{ kind: "replace", path: "f.txt", expectHash: h, find: "alpha", replace: "beta" }] });
  const stray = JSON.stringify({ id: "p2", kind: "edit", path: "f.txt", edits: [{ kind: "replace", path: "f.txt", expectHash: h, find: "alpha", replace: "beta" }] });
  const fin = '{"id":"p1","kind":"finish"}';
  const store = new QualStore(join(tmp(), "q.json"));
  const recovers = Object.assign(new MockProvider([fin, stray, edit]), { id: "mock/recovers" });
  const q = await probeActionProtocol(recovers, store, 1);
  assert.equal(q.passed, true);
  assert.equal(q.detail.first_try, "1/2");
  const stubborn = Object.assign(new MockProvider([fin, stray, stray]), { id: "mock/stubborn" });
  assert.equal((await probeActionProtocol(stubborn, store, 1)).passed, false);
});

test("qualification: probe passes a good worker, fails a bad one; probes never grant architecture/review", async () => {
  const store = new QualStore(join(tmp(), "q.json"));
  const good = goodWorker();
  assert.equal((await probeActionProtocol(good, store, 1)).passed, true);
  const bad = Object.assign(new MockProvider(["nope", "nope"]), { id: "mock/bad" });
  const q = await probeActionProtocol(bad, store, 1);
  assert.equal(q.passed, false);
  assert.equal(q.detail.cancellation, "not-probed");
  assert.equal(store.has(good.id, "architecture"), false);
  assert.equal(store.has(good.id, "review"), false);
});

test("routing: only qualified profiles; none → unsupported capability; R0 → no model", async () => {
  const store = new QualStore(join(tmp(), "q.json"));
  const cheap = Object.assign(new MockProvider([]), { id: "mock/cheap" });
  const strong = Object.assign(new MockProvider([]), { id: "mock/strong" });
  assert.match((selectProfile("worker", "R1", [cheap, strong], store) as any).reason, /unsupported capability/);
  store.record({ profileId: "mock/strong", family: "action-protocol", source: "owner-declared", passed: true, detail: {}, at: "t" });
  const pick = selectProfile("worker", "R1", [cheap, strong], store);
  assert.equal(pick.ok && pick.provider.id, "mock/strong"); // cheapest *qualified*, not cheapest
  assert.equal(selectProfile("reviewer", "R2", [strong], store).ok, false); // worker qualification ≠ review
  assert.equal(selectProfile("worker", "R0", [strong], store).ok, false);
  // a changed profile identity (different quantisation/ctx/etc.) has no record
  assert.equal(selectProfile("worker", "R1", [Object.assign(new MockProvider([]), { id: "mock/strong@ctx8192" })], store).ok, false);
});

// ---------- risk ----------
test("risk floor: sensitive paths/tags are R3 however small; unknown scope is not low", () => {
  assert.equal(riskFloor({ paths: ["src/auth/session.ts"] }), "R3");
  assert.equal(riskFloor({ paths: ["db/migrations/001.sql"] }), "R3");
  assert.equal(riskFloor({ paths: [".github/workflows/ci.yml"] }), "R3");
  assert.equal(riskFloor({ paths: ["package.json"] }), "R3");
  assert.equal(riskFloor({ paths: ["src/a.ts"], tags: ["financial"] }), "R3");
  assert.equal(riskFloor({ paths: [] }), "R2");
  assert.equal(riskFloor({ paths: ["src/ui/a.ts", "src/api/b.ts"] }), "R2");
  assert.equal(riskFloor({ paths: ["src/ui/a.ts", "src/ui/b.ts"] }), "R1");
  assert.equal(riskFloor({ paths: ["src/ui/a.ts"], recipe: true }), "R0");
  assert.equal(riskFloor({ paths: ["a.txt", "b.txt"] }), "R1"); // root files are one layer
});

// ---------- controller: plan approval, risk recompute, review ----------
const passScript = `import {readFileSync} from "node:fs"; console.log("tests 1"); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`;
function mk(over: Partial<Policy> = {}) {
  const base = tmp();
  const ws = join(base, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "value.txt"), "bad");
  writeFileSync(join(ws, "check.mjs"), passScript);
  const run = new Run({
    workspace: ws, stateDir: join(base, "state"), protectedPaths: ["check.mjs"], riskTier: "R2", egress: "local-only", isolation: "none",
    gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 5000, discover: { regex: "tests (\\d+)", min: 1 } }],
    requiredGates: ["unit"], limits: { aggregateTokens: 50_000, toolActions: 12, semanticRepairs: 1 }, ...over,
  });
  run.start();
  return { run, ws };
}
const fixEdit = (id: string, path = "value.txt") => ({ id, kind: "edit", edits: [{ kind: "replace", path, expectHash: sha256("bad"), find: "bad", replace: "good" }] });

test("R2/R3: no code before an operator approves the plan; models cannot approve", async () => {
  const { run } = mk();
  assert.equal(run.state, "AWAITING_PLAN_APPROVAL");
  assert.equal((await run.handle(fixEdit("a1"))).ok, false);
  assert.equal((await run.handle({ id: "a2", kind: "approve_plan" })).ok, false);
  assert.equal(run.state, "AWAITING_PLAN_APPROVAL");
  run.approvePlan("operator", "1. fix value");
  assert.equal(run.state, "IMPLEMENTING");
});

test("R2 flow: gates pass → REVIEWING → advisory-only review → AWAITING_ACCEPTANCE with plan bound", async () => {
  const { run } = mk();
  run.approvePlan("operator", "plan");
  await run.handle(fixEdit("a1"));
  await run.handle({ id: "a2", kind: "finish" });
  assert.equal(run.state, "REVIEWING");
  assert.equal((await run.handle({ id: "a3", kind: "read", path: "value.txt" })).ok, false); // no actions while under review
  const advisory: Finding = { severity: "advisory", criterion: "c", location: "value.txt", evidence: "e", consequence: "minor" };
  run.completeReview([advisory]);
  assert.equal(run.state, "AWAITING_ACCEPTANCE");
  assert.equal(run.evidence?.planHash, sha256("plan"));
  assert.equal(run.evidence?.findings?.length, 1);
});

test("blocking review finding → bounded repair, not acceptance", async () => {
  const { run } = mk();
  run.approvePlan("operator", "plan");
  await run.handle(fixEdit("a1"));
  await run.handle({ id: "a2", kind: "finish" });
  run.completeReview([{ severity: "blocking", criterion: "c", location: "value.txt:1", evidence: "e", consequence: "x" }]);
  assert.equal(run.state, "BOUNDED_REPAIR");
  assert.equal(run.evidence, undefined);
});

test("risk recomputed from the actual diff: R1-approved run touching a migration stops for re-approval", async () => {
  const { run, ws } = mk({ riskTier: "R1" });
  mkdirSync(join(ws, "db/migrations"), { recursive: true });
  await run.handle(fixEdit("a1"));
  await run.handle({ id: "a2", kind: "edit", edits: [{ kind: "create", path: "db/migrations/002.sql", content: "drop table users;" }] });
  await run.handle({ id: "a3", kind: "finish" });
  assert.equal(run.state, "NEEDS_INPUT");
  assert.equal(run.evidence, undefined);
});

test("review is stale if the candidate changes while under review", async () => {
  const { run, ws } = mk();
  run.approvePlan("operator", "plan");
  await run.handle(fixEdit("a1"));
  await run.handle({ id: "a2", kind: "finish" });
  writeFileSync(join(ws, "value.txt"), "good plus change");
  run.completeReview([]);
  assert.equal(run.state, "BOUNDED_REPAIR");
  assert.equal(run.evidence, undefined);
});

// ---------- roles ----------
const ctx = (provider: any, egress: "local-only" | "hosted-allowed" = "local-only") => ({ provider, ledger: new Ledger({ aggregateTokens: 50_000, toolActions: 5, semanticRepairs: 1 }), egress });
const plan = { decisions: ["d"], assumptions: ["a"], interfaces: ["i"], failureModes: ["f"], steps: ["s1"] };

test("architect: validated closed plan; extra fields, empty steps, non-JSON rejected; ledger charged", async () => {
  const c = ctx(new MockProvider([{ content: JSON.stringify(plan), usage: { input: 100, output: 50 } }]));
  assert.deepEqual(await architect(c, { goal: "g", acceptance: ["a"], context: "ctx" }), plan);
  assert.equal(c.ledger.tokens, 150);
  for (const bad of [{ ...plan, approved: true }, { ...plan, steps: [] }, "not json"]) {
    await assert.rejects(architect(ctx(new MockProvider([typeof bad === "string" ? bad : JSON.stringify(bad)])), { goal: "g", acceptance: [], context: "" }), RoleFailed);
  }
});

test("reviewer: sees goal + changes + controller-run checks, no implementer self-assessment; findings validated", async () => {
  const p = new MockProvider([JSON.stringify({ findings: [{ severity: "blocking", criterion: "c1", location: "a.ts:3", evidence: "e", consequence: "x" }] })]);
  const f = await review(ctx(p), { goal: "GOALTEXT", acceptance: ["AC1"], changed: [{ path: "a.ts", before: "old", after: "new" }], gates: [{ gateId: "unit", status: "pass" }] });
  assert.equal(f[0]!.severity, "blocking");
  const sent = p.calls[0]!.prompt;
  assert.match(sent, /GOALTEXT/); assert.match(sent, /BEFORE:\nold/); assert.match(sent, /unit=pass/);
  assert.doesNotMatch(sent, /I have completed|all tests pass|looks good/i);
  const bad = (x: object) => review(ctx(new MockProvider([JSON.stringify(x)])), { goal: "g", acceptance: [], changed: [], gates: [] });
  await assert.rejects(bad({ findings: [{ severity: "blocking", criterion: "c", location: "", evidence: "e", consequence: "x" }] }), RoleFailed); // blocking needs a location
  await assert.rejects(bad({ findings: [{ severity: "info", criterion: "c", location: "l", evidence: "e", consequence: "x" }] }), RoleFailed);
  await assert.rejects(bad({ findings: [], verdict: "approved" }), RoleFailed); // a reviewer cannot approve
});

test("roles obey egress: hosted provider under local-only never receives the prompt", async () => {
  const hosted = Object.assign(new MockProvider([JSON.stringify(plan)]), { hosted: true });
  await assert.rejects(architect(ctx(hosted), { goal: "g", acceptance: [], context: "secret source" }), /local-only/);
  assert.equal(hosted.calls.length, 0);
});
