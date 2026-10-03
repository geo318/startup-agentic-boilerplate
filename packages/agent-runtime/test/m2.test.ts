import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compile, ContextTooLarge } from "../src/context.ts";
import { drive, type Task } from "../src/drive.ts";
import { OllamaProvider } from "../src/ollama.ts";
import { type Policy, Run } from "../src/run.ts";

// Fake Ollama: verifies our wire protocol only. It says nothing about any real model.
async function fakeOllama(reply: (body: any) => any, tags: string[] = ["tiny:1b"]) {
  const seen: any[] = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: tags.map((name) => ({ name })) }));
      const body = JSON.parse(raw);
      seen.push(body);
      const r = reply(body);
      if (r === "hang") return;
      res.statusCode = r.status ?? 200;
      return res.end(JSON.stringify(r.body ?? r));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { baseUrl, seen, close: () => srv.close() };
}
const profile = (baseUrl: string, timeoutMs = 3000) => ({
  baseUrl,
  model: "tiny:1b",
  numCtx: 4096,
  temperature: 0,
  timeoutMs,
});

test("ollama: request carries schema, limits, ctx; usage read from server counters", async () => {
  const f = await fakeOllama(() => ({
    message: { content: "{}" },
    done_reason: "stop",
    prompt_eval_count: 11,
    eval_count: 5,
  }));
  const p = new OllamaProvider(profile(f.baseUrl));
  const r = await p.generate({ system: "s", prompt: "u", maxOutputTokens: 123, schema: { type: "object" } });
  assert.deepEqual(r.usage, { input: 11, output: 5 });
  assert.equal(f.seen[0].stream, false);
  assert.deepEqual(f.seen[0].format, { type: "object" });
  assert.equal(f.seen[0].options.num_predict, 123);
  assert.equal(f.seen[0].options.num_ctx, 4096);
  assert.match(p.id, /tiny:1b@ctx4096/);
  f.close();
});

test("ollama: length/error/http failure/timeout are non-executable; missing counters = unknown usage", async () => {
  const cases: Array<[any, string]> = [
    [{ message: { content: "{" }, done_reason: "length" }, "length"],
    [{ status: 500, body: {} }, "error"],
    ["hang", "error"],
  ];
  for (const [reply, expected] of cases) {
    const f = await fakeOllama(() => reply);
    const r = await new OllamaProvider(profile(f.baseUrl, 300)).generate({
      system: "",
      prompt: "",
      maxOutputTokens: 5,
    });
    assert.equal(r.finishReason, expected);
    f.close();
  }
  const f = await fakeOllama(() => ({ message: { content: "{}" }, done_reason: "stop" }));
  assert.equal(
    (await new OllamaProvider(profile(f.baseUrl)).generate({ system: "", prompt: "", maxOutputTokens: 5 })).usage,
    null,
  );
  f.close();
});

test("ollama probe: reachable+pulled ok; wrong model and dead server reported, nothing pulled", async () => {
  const f = await fakeOllama(() => ({}));
  assert.equal((await new OllamaProvider(profile(f.baseUrl)).probe()).ok, true);
  assert.match((await new OllamaProvider({ ...profile(f.baseUrl), model: "other:7b" }).probe()).reason!, /not pulled/);
  f.close();
  assert.match((await new OllamaProvider(profile("http://127.0.0.1:1")).probe()).reason!, /unreachable/);
});

function project(files: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), "m2-"));
  const ws = join(base, "ws");
  mkdirSync(ws);
  for (const [k, v] of Object.entries(files)) {
    mkdirSync(join(ws, k, ".."), { recursive: true });
    writeFileSync(join(ws, k), v);
  }
  return { base, ws };
}

test("context: mandatory never truncated; optional only if structurally related and capped; rest is a manifest", () => {
  const { ws } = project({
    "src/a.ts": 'import { dep } from "./dep";\nexport const a = dep;',
    "src/dep.ts": "export const dep = 1;",
    "src/a.unit.test.ts": 'import { a } from "./a";',
    "src/caller.ts": 'import { a } from "./a";',
    "src/unrelated-invoice.ts": "invoice total year week date test goal ".repeat(20),
    "big/caller.ts": 'import { a } from "../src/a";\n' + "x".repeat(20000),
  });
  assert.throws(() => compile(ws, ["src/a.ts"], 5), ContextTooLarge);
  const p = compile(ws, ["src/a.ts"], 8000);
  assert.deepEqual(
    p.excerpts.map((e) => [e.path, e.reason]),
    [
      ["src/a.ts", "mandatory"],
      ["src/a.unit.test.ts", "related"],
      ["src/dep.ts", "related"],
    ],
  );
  assert.ok(!p.excerpts.some((e) => e.path.includes("unrelated")), "word overlap must not pull files in");
  assert.ok(p.omitted.some((o) => o.path === "src/caller.ts") && p.omitted.some((o) => o.path === "big/caller.ts"));
  assert.ok(p.excerpts.every((e) => /^[0-9a-f]{64}$/.test(e.hash)));
  assert.equal(compile(ws, ["src/a.ts"], 8000, { maxOptional: 0 }).excerpts.length, 1);
});

test("driver blocks (not truncates) when mandatory context cannot fit", async () => {
  const { base, ws } = project({ "big.ts": "x".repeat(40_000), "check.mjs": "" });
  const run = mkRun(base, ws, `console.log("tests 1")`);
  const task: Task = { goal: "g", acceptance: [], files: ["big.ts"] };
  await drive(run, new OllamaProvider(profile("http://127.0.0.1:1")), ws, task);
  assert.equal(run.state, "BLOCKED");
});

function mkRun(base: string, ws: string, check: string, over: Partial<Policy> = {}) {
  writeFileSync(join(ws, "check.mjs"), check);
  const run = new Run({
    workspace: ws,
    stateDir: join(base, "state"),
    protectedPaths: ["check.mjs"],
    riskTier: "R1",
    egress: "local-only",

    gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 5000, discover: { regex: "tests (\\d+)", min: 1 } }],
    requiredGates: ["unit"],
    limits: { aggregateTokens: 40_000, toolActions: 12, semanticRepairs: 1 },
    ...over,
  });
  run.start();
  return run;
}

test("R0 recipe: zero model calls, accepted after trusted checks", async () => {
  const { base, ws } = project({ "value.txt": "bad" });
  const run = mkRun(
    base,
    ws,
    `import {readFileSync} from "node:fs"; console.log("tests 1"); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`,
  );
  const out = await run.recipe({ path: "value.txt", find: "bad", replace: "good" });
  assert.equal(out.ok, true);
  assert.equal(run.ledger.tokens, 0);
  run.accept("operator");
  assert.equal(run.state, "ACCEPTED");
});

test("diagnostics are compact and a repeated identical failure stops after no new information", async () => {
  const { base, ws } = project({ "value.txt": "bad" });
  const run = mkRun(
    base,
    ws,
    `console.log("tests 1\\nline ".repeat(1)); for (let i=0;i<50;i++) console.log("noise "+i); console.error("AssertionError: expected good"); process.exit(1)`,
  );
  const first = await run.handle({ id: "f1", kind: "finish" });
  assert.equal(run.state, "BOUNDED_REPAIR");
  const d = first.data as any;
  assert.equal(d.tail.split("\n").length <= 15, true);
  assert.match(d.tail, /AssertionError/);
  await run.handle({ id: "f2", kind: "finish" }); // same failure, nothing changed
  assert.equal(run.state, "ESCALATED");
});

test("ollama worker through the driver: fake server replies drive a real run to AWAITING_ACCEPTANCE", async () => {
  const { base, ws } = project({ "value.txt": "bad" });
  const run = mkRun(
    base,
    ws,
    `import {readFileSync} from "node:fs"; console.log("tests 1"); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`,
  );
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update("bad").digest("hex");
  const replies = [
    {
      id: "1",
      kind: "edit",
      edits: [{ kind: "replace", path: "value.txt", expectHash: h, find: "bad", replace: "good" }],
    },
    { id: "2", kind: "finish" },
  ];
  const f = await fakeOllama(() => ({
    message: { content: JSON.stringify(replies.shift()) },
    done_reason: "stop",
    prompt_eval_count: 200,
    eval_count: 40,
  }));
  await drive(run, new OllamaProvider(profile(f.baseUrl)), ws, {
    goal: "make value.txt say good",
    acceptance: ["check passes"],
    files: ["value.txt"],
  });
  assert.equal(run.state, "AWAITING_ACCEPTANCE");
  assert.equal(run.ledger.tokens, 480);
  f.close(); // close first: a failing assertion must not leave the server holding the process open
  assert.equal(f.seen[0].format.additionalProperties, false); // constrained output was requested, and it is closed
  assert.deepEqual(f.seen[0].format.properties.kind.enum, [
    "read",
    "read_many",
    "edit",
    "edit_and_finish",
    "run_gate",
    "finish",
    "blocked",
  ]);
});

test("Ollama identity binds every profile field and is stable across key order", () => {
  const base = profile("http://127.0.0.1:11434");
  const id = new OllamaProvider(base).id;
  assert.equal(new OllamaProvider({ ...base }).id, id);
  assert.equal(
    new OllamaProvider({
      timeoutMs: base.timeoutMs,
      temperature: base.temperature,
      numCtx: base.numCtx,
      model: base.model,
      baseUrl: base.baseUrl,
    }).id,
    id,
  );
  for (const changed of [
    { baseUrl: "http://127.0.0.1:11435" },
    { model: "other" },
    { numCtx: 8192 },
    { temperature: 0.5 },
    { timeoutMs: 5000 },
  ]) {
    assert.notEqual(new OllamaProvider({ ...base, ...changed }).id, id);
  }
});
