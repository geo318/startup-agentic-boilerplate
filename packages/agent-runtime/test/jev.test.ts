import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JevClient, JevInvalid, type DecisionTransport, type JevResult, type Question } from "../src/jev/client.ts";
import { calibrate } from "../src/jev/calibrate.ts";
import { ESCAPES, Fabric, type FabricPolicy, readTelemetry } from "../src/jev/fabric.ts";
import { loadSecrets } from "../src/secrets.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "jev-"));
const OPTS = ["standard-worker", "ask-clarification", ...Object.keys(ESCAPES)];
const dist = (win: string, p = 0.9) =>
  Object.fromEntries(OPTS.map((o) => [o, o === win ? p : (1 - p) / (OPTS.length - 1)]));
const answer = (win: string, p = 0.9) => ({ type: "choice", choice: win, confidence: p, probabilities: dist(win, p) });

async function server(reply: (body: any, headers: any) => { status?: number; body?: unknown } | "hang") {
  const seen: Array<{ body: any; headers: any }> = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ body, headers: req.headers });
      const r = reply(body, req.headers);
      if (r === "hang") return;
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { baseUrl: `http://127.0.0.1:${(srv.address() as any).port}`, seen, close: () => srv.close() };
}
const q: Record<string, Question> = {
  route: { instructions: "pick", criteria: Object.fromEntries(OPTS.map((o) => [o, o])) },
};
const ok = (win = "standard-worker", p = 0.9) => ({
  model: "jev-test-1",
  answers: { route: answer(win, p) },
  usage: { input_tokens: 120, output_tokens: 8 },
});

test("client: documented request shape, bearer key only in the header, validated response", async () => {
  const s = await server(() => ({ body: ok() }));
  const r = await new JevClient({ apiKey: "k-secret", baseUrl: s.baseUrl }).choice({ state: "S", questions: q });
  assert.equal(s.seen[0]!.headers.authorization, "Bearer k-secret");
  assert.ok(!JSON.stringify(s.seen[0]!.body).includes("k-secret"));
  assert.equal(s.seen[0]!.body.model, "jev-latest");
  assert.equal(s.seen[0]!.body.questions.route.type, "choice");
  assert.deepEqual(Object.keys(s.seen[0]!.body.questions.route.criteria), OPTS);
  assert.equal(r.model, "jev-test-1");
  assert.deepEqual(r.usage, { input: 120, output: 8 });
  s.close();
});

test("client: every kind of malformed distribution is rejected", async () => {
  const bad: Array<[string, (b: any) => any]> = [
    [
      "missing option",
      (b) => {
        delete b.answers.route.probabilities.unknown;
        return b;
      },
    ],
    [
      "extra option",
      (b) => {
        b.answers.route.probabilities.invented = 0;
        return b;
      },
    ],
    [
      "not summing to 1",
      (b) => {
        b.answers.route.probabilities["standard-worker"] = 0.5;
        return b;
      },
    ],
    [
      "NaN/non-finite",
      (b) => {
        b.answers.route.probabilities.unknown = null;
        return b;
      },
    ],
    [
      "negative",
      (b) => {
        b.answers.route.probabilities.unknown = -0.1;
        b.answers.route.probabilities["standard-worker"] = 1.0;
        return b;
      },
    ],
    [
      "choice not offered",
      (b) => {
        b.answers.route.choice = "rm-rf";
        return b;
      },
    ],
    [
      "choice is not argmax",
      (b) => {
        b.answers.route.choice = "ask-clarification";
        return b;
      },
    ],
    [
      "confidence out of range",
      (b) => {
        b.answers.route.confidence = 1.5;
        return b;
      },
    ],
    [
      "extra answer",
      (b) => {
        b.answers.other = answer("standard-worker");
        return b;
      },
    ],
    [
      "missing answer",
      (b) => {
        b.answers = {};
        return b;
      },
    ],
    [
      "no model",
      (b) => {
        delete b.model;
        return b;
      },
    ],
  ];
  for (const [name, mutate] of bad) {
    const s = await server(() => ({ body: mutate(ok()) }));
    await assert.rejects(
      new JevClient({ apiKey: "k", baseUrl: s.baseUrl }).choice({ state: "S", questions: q }),
      JevInvalid,
      name,
    );
    s.close();
  }
});

test("client: no credential, http error and timeout are 'unavailable', never a guess", async () => {
  await assert.rejects(new JevClient({ apiKey: undefined }).choice({ state: "S", questions: q }), /no Jev credential/);
  const s401 = await server(() => ({ status: 401 }));
  await assert.rejects(
    new JevClient({ apiKey: "k", baseUrl: s401.baseUrl }).choice({ state: "S", questions: q }),
    /http 401/,
  );
  s401.close();
  const hang = await server(() => "hang");
  await assert.rejects(
    new JevClient({ apiKey: "k", baseUrl: hang.baseUrl, timeoutMs: 200 }).choice({ state: "S", questions: q }),
    /request failed/,
  );
  hang.close();
  await assert.rejects(
    new JevClient({ apiKey: "k" }).choice({
      state: "S",
      questions: { r: { instructions: "x", criteria: { only: "one" } } },
    }),
    /needs 2/,
  );
});

// ---------- fabric ----------
function fake(resultFor: (qs: Record<string, Question>) => JevResult | Error) {
  const t = {
    calls: 0,
    last: undefined as undefined | Record<string, Question>,
    async choice(req: { state: string; questions: Record<string, Question> }) {
      t.calls++;
      t.last = req.questions;
      const r = resultFor(req.questions);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return t satisfies DecisionTransport & { calls: number };
}
const res = (win: string, p: number, model = "jev-test-1"): JevResult => ({
  model,
  answers: { route: { choice: win, confidence: p, probabilities: dist(win, p) } },
  usage: { input: 100, output: 5 },
  latencyMs: 12,
});
const item = {
  id: "route",
  instructions: "pick the route",
  options: { "standard-worker": "go", "ask-clarification": "ask" },
  rulesDefault: "standard-worker",
};
const policy = (over: Partial<FabricPolicy> = {}): FabricPolicy => ({
  egress: "hosted-allowed",
  allowSource: false,
  modes: { "workflow-select": "enabled" },
  ...over,
});
const cal = (threshold: number | null) => [
  { id: "c1", family: "workflow-select" as const, threshold, n: 50, target: 0.95 },
];
const mk = (t: DecisionTransport, p: FabricPolicy, calibrations = cal(0.8)) => {
  const f = join(tmp(), "t.jsonl");
  return { fabric: new Fabric({ transport: t, policy: p, telemetryFile: f, calibrations }), f };
};

test("fabric: disabled makes no call; shadow calls but never changes the decision and logs raw probabilities", async () => {
  const t = fake(() => res("ask-clarification", 0.99));
  const off = mk(t, policy({ modes: {} }));
  assert.equal(
    (await off.fabric.decide("workflow-select", { taskId: "x", state: "S", items: [item] }))[0]!.chosen,
    "standard-worker",
  );
  assert.equal(t.calls, 0);
  const sh = mk(t, policy({ modes: { "workflow-select": "shadow" } }));
  const r = (await sh.fabric.decide("workflow-select", { taskId: "x", state: "S", items: [item] }))[0]!;
  assert.equal(r.chosen, "standard-worker"); // rules win in shadow
  assert.equal(r.jevChoice, "ask-clarification");
  const rec = readTelemetry(sh.f)[0]!;
  assert.equal(rec.mode, "shadow");
  assert.equal(rec.probabilities["ask-clarification"], 0.99);
  assert.equal(rec.resolvedModel, "jev-test-1");
  assert.equal(rec.stateHash.length, 64);
  assert.ok(!JSON.stringify(rec).includes('"state"')); // the evidence itself is not stored
});

test("fabric: enabled acts only when the choice is allowed AND calibrated AND above threshold", async () => {
  const run = async (res_: JevResult, c = cal(0.8)) =>
    (
      await mk(
        fake(() => res_),
        policy(),
        c,
      ).fabric.decide("workflow-select", { taskId: "x", state: "S", items: [item] })
    )[0]!;
  assert.deepEqual((await run(res("ask-clarification", 0.95))).source, "jev");
  assert.equal((await run(res("ask-clarification", 0.5))).fallbackReason, "below-threshold");
  assert.equal((await run(res("ask-clarification", 0.99), cal(null))).fallbackReason, "uncalibrated");
  assert.equal((await run(res("ask-clarification", 0.99), [])).fallbackReason, "uncalibrated");
  for (const escape of Object.keys(ESCAPES))
    assert.equal((await run(res(escape, 0.99))).fallbackReason, `escape:${escape}`);
  // a high-confidence "overconfident" answer outside the allowed options is a fallback, not an action
  const narrow = { ...item, options: { "standard-worker": "go" }, rulesDefault: "standard-worker" };
  const t = fake(() => res("ask-clarification", 0.99));
  const out = await mk(t, policy()).fabric.decide("workflow-select", {
    taskId: "x",
    state: "S",
    items: [narrow, item],
  });
  assert.equal(out.find((o) => o.id === "route")!.chosen, "standard-worker");
});

test("fabric: down, invalid, unknown model revision → conservative rules fallback, nothing thrown", async () => {
  for (const [t, reason] of [
    [fake(() => new JevInvalid("bad")), "invalid-response"],
    [fake(() => new Error("down")), "unavailable"],
  ] as const) {
    const m = mk(t, policy());
    const r = (await m.fabric.decide("workflow-select", { taskId: "x", state: "S", items: [item] }))[0]!;
    assert.equal(r.chosen, "standard-worker");
    assert.equal(r.fallbackReason, reason);
    assert.equal(readTelemetry(m.f)[0]!.fallback, reason);
  }
  const pinned = mk(
    fake(() => res("ask-clarification", 0.99, "jev-moved-2")),
    policy({ pinnedModel: "jev-test-1" }),
  );
  assert.equal(
    (await pinned.fabric.decide("workflow-select", { taskId: "x", state: "S", items: [item] }))[0]!.fallbackReason,
    "model-mismatch",
  );
  const noKey = new Fabric({ policy: policy(), telemetryFile: join(tmp(), "t.jsonl"), calibrations: cal(0.8) });
  assert.equal(
    (await noKey.decide("workflow-select", { taskId: "x", state: "S", items: [item] }))[0]!.fallbackReason,
    "unavailable",
  );
});

test("fabric: egress. local-only policy and source-sending families never reach the transport", async () => {
  const t = fake(() => res("standard-worker", 0.9));
  const local = mk(t, policy({ egress: "local-only" }));
  assert.equal(
    (await local.fabric.decide("workflow-select", { taskId: "x", state: "S", items: [item] }))[0]!.fallbackReason,
    "egress",
  );
  const rr = mk(t, policy({ modes: { "retrieval-rerank": "shadow" } }));
  assert.equal(
    (await rr.fabric.decide("retrieval-rerank", { taskId: "x", state: "SOURCE", items: [item] }))[0]!.fallbackReason,
    "source-egress",
  );
  assert.equal(t.calls, 0);
  const allowed = mk(t, policy({ allowSource: true, modes: { "retrieval-rerank": "shadow" } }));
  await allowed.fabric.decide("retrieval-rerank", { taskId: "x", state: "SOURCE", items: [item] });
  assert.equal(t.calls, 1);
});

test("fabric: rules-determined cases skip Jev; identical state hits the cache; families with no consumer cannot be enabled", async () => {
  const t = fake(() => res("standard-worker", 0.9));
  const m = mk(t, policy());
  const only = { ...item, options: { "standard-worker": "go" } };
  await m.fabric.decide("workflow-select", { taskId: "x", state: "S", items: [only] });
  assert.equal(t.calls, 0);
  await m.fabric.decide("workflow-select", { taskId: "x", state: "S", items: [item] });
  await m.fabric.decide("workflow-select", { taskId: "x", state: "S", items: [item] });
  assert.equal(t.calls, 1);
  assert.equal(readTelemetry(m.f).at(-1)!.cached, true);
  assert.throws(
    () => new Fabric({ policy: policy({ modes: { "skill-select": "enabled" } }), telemetryFile: "x" }),
    /nothing in the runtime consumes/,
  );
});

test("batched questions share one request", async () => {
  const t = fake((qs) => ({
    model: "m",
    usage: null,
    latencyMs: 1,
    answers: Object.fromEntries(
      Object.keys(qs).map((id) => [
        id,
        { choice: "standard-worker", confidence: 0.9, probabilities: dist("standard-worker") },
      ]),
    ),
  }));
  const m = mk(t, policy({ modes: { "workflow-select": "shadow" } }));
  await m.fabric.decide("workflow-select", {
    taskId: "x",
    state: "S",
    items: [item, { ...item, id: "q2" }, { ...item, id: "q3" }],
  });
  assert.equal(t.calls, 1);
  assert.deepEqual(Object.keys(t.last!), ["route", "q2", "q3"]);
});

test("calibration: too little data → no threshold; enough accurate high-confidence data → a threshold", () => {
  const few = calibrate(
    "workflow-select",
    Array.from({ length: 10 }, () => ({ confidence: 0.99, jevChoice: "a", truth: "a" })),
  );
  assert.equal(few.threshold, null);
  const rows = [
    ...Array.from({ length: 40 }, () => ({ confidence: 0.97, jevChoice: "a", truth: "a" })),
    ...Array.from({ length: 20 }, (_, i) => ({ confidence: 0.6, jevChoice: "a", truth: i % 2 ? "a" : "b" })),
  ];
  const c = calibrate("workflow-select", rows);
  assert.equal(c.threshold, 0.97);
  const overconfident = calibrate(
    "workflow-select",
    Array.from({ length: 50 }, (_, i) => ({ confidence: 0.99, jevChoice: "a", truth: i < 25 ? "a" : "b" })),
  );
  assert.equal(overconfident.threshold, null); // "0.99 means safe" is never assumed: 50% accurate at 0.99 stays unusable
});

test("secrets: loaded from the user-level store; a group-readable file is refused; nothing here is project-local", () => {
  const home = tmp();
  const f = join(home, "secrets.env");
  writeFileSync(f, 'JEV_API_KEY="abc123"\n# comment\nOTHER=x\n');
  chmodSync(f, 0o644);
  assert.throws(() => loadSecrets(home), /must not be readable by group/);
  chmodSync(f, 0o600);
  assert.equal(loadSecrets(home).JEV_API_KEY, "abc123");
  assert.deepEqual(loadSecrets(tmp()), {});
});

test("fabric: allowUncalibrated lets an enabled family act before calibration, recorded as uncalibrated; a real threshold still applies", async () => {
  const run = async (c: ReturnType<typeof cal>, conf = 0.9) => {
    const m = mk(
      fake(() => res("ask-clarification", conf)),
      policy({ allowUncalibrated: true }),
      c,
    );
    const r = (await m.fabric.decide("workflow-select", { taskId: "x", state: "S", items: [item] }))[0]!;
    return { r, rec: readTelemetry(m.f)[0]! };
  };
  const none = await run([]);
  assert.equal(none.r.source, "jev");
  assert.equal(none.r.uncalibrated, true);
  assert.equal(none.rec.uncalibrated, true);
  assert.equal((await run(cal(null))).r.source, "jev");
  assert.equal((await run(cal(0.95), 0.9)).r.fallbackReason, "below-threshold"); // calibration still wins when it exists
  const calibrated = await run(cal(0.8), 0.9);
  assert.equal(calibrated.r.source, "jev");
  assert.equal(calibrated.r.uncalibrated, undefined);
});
