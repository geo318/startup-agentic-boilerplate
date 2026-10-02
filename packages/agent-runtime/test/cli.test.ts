import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as c from "../src/cli/commands.ts";
import { sha256 } from "../src/hash.ts";
import { QualStore } from "../src/qualify.ts";
import { validate } from "../src/schema.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "cli-"));
const J = (v: unknown) => JSON.stringify(v);
const edit = J({
  id: "x",
  kind: "edit",
  edits: [{ kind: "replace", path: "value.txt", expectHash: sha256("bad"), find: "bad", replace: "good" }],
});
const finish = J({ id: "y", kind: "finish" });
const plan = J({ decisions: ["d"], assumptions: ["a"], interfaces: ["i"], failureModes: ["f"], steps: ["fix value"] });

function world(over: { policy?: object; roles?: object; extraProfiles?: object } = {}) {
  const project = tmp(),
    home = tmp();
  mkdirSync(join(project, ".agents"));
  writeFileSync(join(project, "value.txt"), "bad");
  writeFileSync(
    join(project, "check.mjs"),
    `import {readFileSync} from "node:fs"; console.log("tests 1"); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`,
  );
  const script = (name: string, items: string[]) => {
    const f = join(project, `${name}.replay.json`);
    writeFileSync(f, J(items));
    return f;
  };
  const profiles = {
    worker: { kind: "replay", file: script("worker", [edit, finish]) },
    architect: { kind: "replay", file: script("architect", [plan]) },
    reviewer: { kind: "replay", file: script("reviewer", [J({ findings: [] })]) },
    ...(over.extraProfiles ?? {}),
  };
  writeFileSync(
    join(project, ".agents/models.json"),
    J({
      schemaVersion: 1,
      profiles,
      roles: { worker: "worker", architect: "architect", reviewer: "reviewer", ...(over.roles ?? {}) },
    }),
  );
  writeFileSync(
    join(project, ".agents/policy.json"),
    J({
      schemaVersion: 1,
      protectedPaths: ["check.mjs", ".agents"],
      egress: "local-only",
      baseline: "off",
      gates: [
        { id: "unit", argv: ["node", "check.mjs"], timeoutMs: 8000, discover: { regex: "tests (\\d+)", min: 1 } },
      ],
      requiredGates: ["unit"],
      ...(over.policy ?? {}),
    }),
  );
  const out: string[] = [];
  const env = (o: Partial<c.Env> = {}): c.Env => ({
    home,
    project,
    out: (s) => out.push(s),

    user: "tester",

    ...o,
  });
  const qual = (id: string, family: "action-protocol" | "architecture" | "review") =>
    new QualStore(join(home, "qualifications.json")).record({
      profileId: id,
      family,
      source: "owner-declared",
      passed: true,
      detail: {},
      at: "t",
    });
  const contract = (o: object = {}) => {
    const f = join(tmp(), "contract.json");
    writeFileSync(
      f,
      J({
        schemaVersion: 1,
        id: "fix-value",
        goal: "make value.txt say good",
        acceptance: ["check.mjs exits 0"],
        files: ["value.txt"],
        riskTier: "R1",
        budget: "narrow",
        ...o,
      }),
    );
    return f;
  };
  const qualifyAll = () => {
    qual("mock/replay:worker.replay.json", "action-protocol");
    qual("mock/replay:architect.replay.json", "architecture");
    qual("mock/replay:reviewer.replay.json", "review");
  };
  return { project, home, out, env, contract, qual, qualifyAll };
}

test("schema validator: closed objects, enums, patterns; unknown keywords refuse to load", () => {
  const s = {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: { a: { type: "string", pattern: "^x" }, b: { enum: [1, 2] } },
  };
  assert.deepEqual(validate(s, { a: "xy", b: 1 }), []);
  assert.ok(validate(s, { a: "y" }).length);
  assert.ok(validate(s, { a: "x", c: 1 }).some((e) => /unknown field/.test(e)));
  assert.ok(validate(s, {}).some((e) => /missing required/.test(e)));
  assert.throws(() => validate({ type: "string", format: "email" } as any, "x"), /unsupported schema keyword/);
});

test("validate: good files pass; bad contracts reported; doctor runs", async () => {
  const w = world();
  assert.equal(await c.validateFiles(w.env(), [w.contract()]), 0);
  assert.equal(await c.validateFiles(w.env(), [w.contract({ id: "X" })]), 1);
  assert.equal(await c.validateFiles(w.env(), [w.contract({ surprise: true })]), 1);
  assert.equal(await c.validateFiles(w.env(), [w.contract({ riskTier: "R9" })]), 1);
  assert.equal(await c.doctor(w.env()), 0);
});

test("R1 happy path: no prompts; routes only qualified; explicit accept; separate candidate; patch applies", async () => {
  const w = world();
  assert.equal(await c.taskCreate(w.env(), w.contract()), 0);
  // unqualified worker → refused before any state exists

  await assert.rejects(c.taskRun(w.env(), "fix-value"), /unsupported capability.*qualify/);
  assert.equal(existsSync(join(w.home, "tasks/fix-value/candidate")), false);
  w.qualifyAll();
  assert.equal(await c.taskRun(w.env(), "fix-value"), 0);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_ACCEPTANCE");
  assert.equal(readFileSync(join(w.project, "value.txt"), "utf8"), "bad"); // project untouched
  assert.equal(readFileSync(join(w.home, "tasks/fix-value/candidate/value.txt"), "utf8"), "good");
  assert.equal(await c.taskAccept(w.env(), "fix-value"), 0);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "ACCEPTED");
  // export → a patch that applies to the original project
  assert.equal(await c.exportPatch(w.env(), "fix-value"), 0);
  const patch = join(w.home, "tasks/fix-value/changes.patch");
  assert.match(readFileSync(patch, "utf8"), /-bad[\s\S]*\+good/);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: w.project, encoding: "utf8" });
  git("init", "-q");
  assert.equal(git("apply", "--check", patch).status, 0);
});

test("re-running a finished task resumes, does not repeat work or spend", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());

  await c.taskRun(w.env(), "fix-value");
  const before = c.statusOf(w.env(), "fix-value");
  assert.equal(await c.taskRun(w.env(), "fix-value"), 0);
  const after = c.statusOf(w.env(), "fix-value");
  assert.equal(after.state, "AWAITING_ACCEPTANCE");
  assert.equal(after.ledger.tokens, before.ledger.tokens);
});

test("R2: plan written, no code until a human approves; then worker → review → awaiting acceptance", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract({ riskTier: "R2", budget: "standard" }));

  assert.equal(await c.taskRun(w.env(), "fix-value"), 2);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_PLAN_APPROVAL");
  assert.equal(readFileSync(join(w.home, "tasks/fix-value/candidate/value.txt"), "utf8"), "bad");
  assert.equal(await c.taskApprove(w.env(), "fix-value"), 0);
  assert.equal(await c.taskRun(w.env(), "fix-value"), 0);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_ACCEPTANCE");
  const rep = JSON.parse((w.out.length, await c.report(w.env(), "fix-value"), w.out.at(-1)!));
  assert.equal(rep.evidence.tier, "R2");
  assert.ok(rep.evidence.planHash);
});

test("plan file tampering after it was written is detected at approval", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract({ riskTier: "R2", budget: "standard" }));

  await c.taskRun(w.env(), "fix-value");
  const f = join(w.home, "tasks/fix-value/plan.json");
  const p = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, J({ ...p, text: p.text.replace("fix value", "delete everything") }));

  await assert.rejects(c.taskApprove(w.env(), "fix-value"), /modified after/);
});

test("risk floor from declared scope raises the tier; R3 requires plan approval", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract({ scope: ["db/migrations/002.sql"] }));

  assert.equal(await c.taskRun(w.env(), "fix-value"), 2);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_PLAN_APPROVAL");
});

test("hosted profile under local-only policy is blocked before anything leaves", async () => {
  const w = world({
    extraProfiles: { handoff: { kind: "manual", dir: tmp(), label: "chat" } },
    roles: { worker: "handoff" },
  });
  w.qual("manual/chat", "action-protocol");
  await c.taskCreate(w.env(), w.contract());

  assert.equal(await c.taskRun(w.env(), "fix-value"), 1);
  assert.match(String(c.statusOf(w.env(), "fix-value").why), /hosted but the policy is local-only/);
});

test("unresolved questions stop the run; cancel is final; unknown task is an error", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract({ unresolvedQuestions: ["which currency?"] }));
  await assert.rejects(c.taskRun(w.env(), "fix-value"), /unresolved design decision/);
  await assert.rejects(c.taskStatus(w.env(), "nope"), /no such task/);
  const w2 = world();
  w2.qualifyAll();
  await c.taskCreate(w2.env(), w2.contract({ riskTier: "R2", budget: "standard" }));

  await c.taskRun(w2.env(), "fix-value");
  assert.equal(await c.taskCancel(w2.env(), "fix-value"), 0);
  assert.equal(await c.taskRun(w2.env(), "fix-value"), 1);
});

test("R0 recipe runs with no model configured at all", async () => {
  const w = world();
  writeFileSync(join(w.project, ".agents/models.json"), "{}"); // would be invalid if loaded as models
  await c.taskCreate(
    w.env(),
    w.contract({ riskTier: "R0", scope: ["value.txt"], recipe: { path: "value.txt", find: "bad", replace: "good" } }),
  );

  assert.equal(await c.taskRun(w.env(), "fix-value"), 0);
  assert.equal(c.statusOf(w.env(), "fix-value").ledger.tokens, 0);
});

test("qualify: explicit owner declaration works without prompts", async () => {
  const w = world();
  assert.equal(await c.qualify(w.env(), "reviewer", "review"), 0);
  assert.equal(
    new QualStore(join(w.home, "qualifications.json")).has("mock/replay:reviewer.replay.json", "review"),
    true,
  );
});

test("verify: re-runs the gates on the exact candidate; detects tampering afterwards; changes no state", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());

  await c.taskRun(w.env(), "fix-value");
  const before = c.statusOf(w.env(), "fix-value");
  assert.equal(await c.verifyTask(w.env(), "fix-value"), 0);
  assert.match(w.out.at(-1)!, /^verified:/);
  assert.deepEqual(c.statusOf(w.env(), "fix-value").state, before.state);
  writeFileSync(join(w.home, "tasks/fix-value/candidate/value.txt"), "good, then edited");
  assert.equal(await c.verifyTask(w.env(), "fix-value"), 1);
  assert.match(w.out.at(-1)!, /candidate changed/);
});

// ---------- Jev decision fabric through the CLI ----------
const jevFake = (choiceFor: (q: string) => string, p = 0.97, calls: { n: number } = { n: 0 }) => ({
  async choice(req: { state: string; questions: Record<string, { criteria: Record<string, string> }> }) {
    calls.n++;
    return {
      model: "jev-fake-1",
      usage: { input: 80, output: 4 },
      latencyMs: 5,
      answers: Object.fromEntries(
        Object.entries(req.questions).map(([id, q]) => {
          const opts = Object.keys(q.criteria),
            win = choiceFor(id);
          return [
            id,
            {
              choice: win,
              confidence: p,
              probabilities: Object.fromEntries(opts.map((o) => [o, o === win ? p : (1 - p) / (opts.length - 1)])),
            },
          ];
        }),
      ),
    };
  },
});
const jevPolicy = (mode: string, extra: object = {}) => ({
  egress: "hosted-allowed",
  jev: { modes: { "workflow-select": mode }, ...extra },
});

test("jev shadow: records what Jev would do, the run proceeds exactly as it would without it; telemetry has no source", async () => {
  const calls = { n: 0 };
  const w = world({ policy: jevPolicy("shadow") });
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());

  assert.equal(
    await c.taskRun(w.env({ jevTransport: jevFake(() => "ask-clarification", 0.99, calls) }), "fix-value"),
    0,
  ); // Jev says "ask"; the run still goes ahead
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_ACCEPTANCE");
  assert.equal(calls.n, 1);
  const tel = readFileSync(join(w.home, "telemetry/jev.jsonl"), "utf8");
  assert.match(tel, /"mode":"shadow"/);
  assert.doesNotMatch(tel, /make value\.txt say good/); // the goal text itself is never stored
  await c.jevReport(w.env());
  assert.match(w.out.at(-2)!, /would change the rules' choice 1/);
});

test("jev enabled but uncalibrated: no effect. Enabled + calibrated + confident: stops BEFORE any model call, never skips a check", async () => {
  const w = world({ policy: jevPolicy("enabled") });
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());

  assert.equal(await c.taskRun(w.env({ jevTransport: jevFake(() => "ask-clarification") }), "fix-value"), 0); // uncalibrated → rules decide
  const w2 = world({ policy: jevPolicy("enabled") });
  w2.qualifyAll();
  writeFileSync(
    join(w2.home, "calibration.json"),
    JSON.stringify([{ id: "c1", family: "workflow-select", threshold: 0.9, n: 60, target: 0.95 }]),
  );
  await c.taskCreate(w2.env(), w2.contract());

  assert.equal(await c.taskRun(w2.env({ jevTransport: jevFake(() => "ask-clarification", 0.97) }), "fix-value"), 2);
  const st = c.statusOf(w2.env(), "fix-value");
  assert.equal(st.state, "NEEDS_INPUT");
  assert.equal(st.ledger.tokens, 0); // no worker call happened
});

test("jev down or local-only: the task runs normally with the same checks", async () => {
  const down = world({ policy: jevPolicy("enabled") });
  down.qualifyAll();
  await c.taskCreate(down.env(), down.contract());

  const boom = {
    async choice() {
      throw new Error("jev unreachable");
    },
  };
  assert.equal(await c.taskRun(down.env({ jevTransport: boom }), "fix-value"), 0);
  const local = world({ policy: { egress: "local-only", jev: { modes: { "workflow-select": "shadow" } } } });
  local.qualifyAll();
  await c.taskCreate(local.env(), local.contract());

  const calls = { n: 0 };
  assert.equal(
    await c.taskRun(local.env({ jevTransport: jevFake(() => "ask-clarification", 0.99, calls) }), "fix-value"),
    0,
  );
  assert.equal(calls.n, 0);
});

test("jev not configured: nothing is called and no telemetry exists (local-only projects need no Jev)", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());

  const calls = { n: 0 };
  await c.taskRun(w.env({ jevTransport: jevFake(() => "ask-clarification", 0.99, calls) }), "fix-value");
  assert.equal(calls.n, 0);
  assert.equal(existsSync(join(w.home, "telemetry/jev.jsonl")), false);
});

test("jev calibrate from labels writes a per-family calibration; too few labels → unusable", async () => {
  const w = world({ policy: jevPolicy("shadow") });
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());

  await c.taskRun(w.env({ jevTransport: jevFake(() => "standard-worker", 0.97) }), "fix-value");
  const rec = JSON.parse(readFileSync(join(w.home, "telemetry/jev.jsonl"), "utf8").trim().split("\n").at(-1)!);
  const labels = join(w.home, "labels.json");
  writeFileSync(labels, JSON.stringify({ [rec.stateHash]: "standard-worker" }));
  await c.jevCalibrate(w.env(), "workflow-select", labels);
  assert.match(w.out.at(-2) ?? w.out.at(-1)!, /threshold none/);
  await c.jevStatus(w.env({ secrets: { JEV_API_KEY: "x" } }));
  assert.match(w.out.join("\n"), /credential: present \(user-level store\)/);
  assert.ok(!w.out.join("\n").includes('"x"'));
});

// ---------- on/off switch ----------
test("workflow switch: default ON; OFF runs nothing and spends nothing and a literal yes; enable works anywhere", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());
  assert.equal(c.workflowEnabled(w.env()), true); // no "enabled" key in the policy = on
  await c.doctor(w.env());
  assert.match(w.out.join("\n"), /workflow\s+ON/);
  assert.equal(await c.disableWorkflow(w.env()), 0);
  assert.equal(c.workflowEnabled(w.env()), false);
  assert.equal(JSON.parse(readFileSync(join(w.project, ".agents/policy.json"), "utf8")).enabled, false);

  assert.equal(await c.taskRun(w.env(), "fix-value"), 2); // refused: no state, no candidate, no model call
  assert.equal(existsSync(join(w.home, "tasks/fix-value/candidate")), false);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "NOT_STARTED");
  await assert.rejects(c.qualify(w.env(), "worker"), /turned off/);
  await c.doctor(w.env());
  assert.match(w.out.join("\n"), /workflow\s+OFF/);
  assert.equal(await c.enableWorkflow(w.env({})), 0);
  assert.equal(c.workflowEnabled(w.env()), true);

  assert.equal(await c.taskRun(w.env(), "fix-value"), 0);
});

test("an agent cannot flip the switch from inside a task: .agents/ is a protected path", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());

  await c.taskRun(w.env(), "fix-value");
  const cand = join(w.home, "tasks/fix-value/candidate/.agents/policy.json");
  // the policy copy inside the candidate is protected, and the real policy lives in the project (never edited by tasks)
  const { applyEdits } = await import("../src/edits.ts");
  assert.throws(
    () =>
      applyEdits(
        join(w.home, "tasks/fix-value/candidate"),
        [{ kind: "replace_file", path: ".agents/policy.json", expectHash: "x", content: "{}" }],
        ["check.mjs", ".agents"],
      ),
    /protected path/,
  );
  assert.ok(existsSync(cand));
});

// ---------- Jev auto-use when a key exists ----------
test("jev requires explicit opt-in as well as a key; no key → untouched", async () => {
  const calls = { n: 0 };
  const w = world({ policy: { egress: "hosted-allowed", jev: { auto: true } } });
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());

  assert.equal(
    await c.taskRun(
      w.env({ secrets: { JEV_API_KEY: "k" }, jevTransport: jevFake(() => "ask-clarification", 0.99, calls) }),
      "fix-value",
    ),
    0,
  );
  assert.ok(calls.n >= 1);
  assert.match(readFileSync(join(w.home, "telemetry/jev.jsonl"), "utf8"), /workflow-select/);
  // the run itself was unaffected: Jev said "ask" at 0.99 but nothing is calibrated, so the rules decided
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_ACCEPTANCE");
  const none = world({ policy: { egress: "hosted-allowed" } });
  none.qualifyAll();
  await c.taskCreate(none.env(), none.contract());
  const calls2 = { n: 0 };
  await c.taskRun(none.env({ jevTransport: jevFake(() => "ask-clarification", 0.99, calls2) }), "fix-value"); // no secrets
  assert.equal(calls2.n, 0);
  assert.equal(existsSync(join(none.home, "telemetry/jev.jsonl")), false);
});

test("jev auto: opt-out and explicit modes win; local-only egress means key present but not used, and doctor says why", async () => {
  const optOut = world({ policy: { egress: "hosted-allowed", jev: { auto: false } } });
  optOut.qualifyAll();
  await c.taskCreate(optOut.env(), optOut.contract());
  const calls = { n: 0 };
  await c.taskRun(
    optOut.env({ secrets: { JEV_API_KEY: "k" }, jevTransport: jevFake(() => "x", 0.9, calls) }),
    "fix-value",
  );
  assert.equal(calls.n, 0);
  const local = world({ policy: { jev: { auto: true } } }); // explicit opt-in, but local-only
  await c.doctor(local.env({ secrets: { JEV_API_KEY: "k" } }));
  assert.match(local.out.join("\n"), /jev\s+key\/config present but NOT used: policy egress is local-only/);
  const hosted = world({ policy: { egress: "hosted-allowed", jev: { auto: true } } });
  await c.doctor(hosted.env({ secrets: { JEV_API_KEY: "k" } }));
  assert.match(hosted.out.join("\n"), /jev\s+on \(opt-in: jev.auto true and key present\)/);
  assert.doesNotMatch(hosted.out.join("\n"), /"k"/);
  const nokey = world({ policy: { egress: "hosted-allowed" } });
  await c.doctor(nokey.env());
  assert.match(nokey.out.join("\n"), /jev\s+off \(Jev is opt-in/);
});

test("process level: an unknown subcommand prints usage and runs NOTHING (regression: `jev <x>` used to fall through into `task`)", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const main = join(fileURLToPath(import.meta.url), "..", "..", "src", "cli", "main.ts");
  const home = tmp();
  for (const args of [
    ["jev", "run", "x"],
    ["jev", "create", "/nonexistent.json"],
    ["task", "bogus", "x"],
    ["learn", "bogus"],
    ["nonsense"],
  ]) {
    const r = spawnSync(process.execPath, [main, ...args], {
      encoding: "utf8",
      env: { ...process.env, AGENTIC_HOME: home },
      input: "",
    });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stdout, /^agentic <command>/, args.join(" ")); // usage, not a task error
  }
  assert.equal(existsSync(join(home, "tasks")), false);
});

test("do: derives the contract from --files or the changed tree, refuses to guess scope, runs the task", async () => {
  const w = world();
  w.qualifyAll();

  await assert.rejects(c.doTask(w.env(), "make value.txt say good"), /no files in scope/); // not a git repo → nothing changed
  assert.equal(await c.doTask(w.env(), "make value.txt say good", { files: ["value.txt"] }), 0);
  const id = w.out.join("\n").match(/created task (make-value-txt-say-[a-z0-9-]+)/)![1]!;
  assert.equal(c.statusOf(w.env(), id).state, "AWAITING_ACCEPTANCE");
  assert.match(w.out.join("\n"), new RegExp(`next: node scripts/agentic.mjs status ${id}`));
  assert.match(w.out.join("\n"), /\(R1, budget narrow\)/);
});

test("approved write scope rejects a same-tier sibling edit", async () => {
  const w = world();
  writeFileSync(join(w.project, "other.txt"), "original");
  writeFileSync(
    join(w.project, "worker.replay.json"),
    J([
      J({
        id: "x",
        kind: "edit",
        edits: [{ kind: "replace_file", path: "other.txt", expectHash: sha256("original"), content: "changed" }],
      }),
      edit,
      finish,
    ]),
  );
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract({ scope: ["value.txt"] }));
  await c.taskRun(w.env(), "fix-value");
  assert.equal(readFileSync(join(w.home, "tasks/fix-value/candidate/other.txt"), "utf8"), "original");
  assert.match(
    readFileSync(join(w.home, "tasks/fix-value/state/events.jsonl"), "utf8"),
    /outside approved write scope/,
  );
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_ACCEPTANCE");
});

test("existing colocated acceptance tests cannot be weakened, even inside write scope", async () => {
  const w = world();
  writeFileSync(join(w.project, "value.test.mjs"), "original assertion");
  writeFileSync(
    join(w.project, "worker.replay.json"),
    J([
      J({
        id: "x",
        kind: "edit",
        edits: [
          {
            kind: "replace_file",
            path: "value.test.mjs",
            expectHash: sha256("original assertion"),
            content: "weakened assertion",
          },
        ],
      }),
      edit,
      finish,
    ]),
  );
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract({ scope: ["value.txt", "value.test.mjs"] }));
  await c.taskRun(w.env(), "fix-value");
  assert.equal(readFileSync(join(w.home, "tasks/fix-value/candidate/value.test.mjs"), "utf8"), "original assertion");
  assert.match(readFileSync(join(w.home, "tasks/fix-value/state/events.jsonl"), "utf8"), /protected path/);
});

test("failed cheap worker routes its gate diagnostic to a strong worker", async () => {
  const strongFile = join(tmp(), "strong.json");
  writeFileSync(strongFile, J([edit, finish]));
  const w = world({
    roles: { workerStrong: "strong" },
    extraProfiles: { strong: { kind: "replay", file: strongFile } },
  });
  writeFileSync(join(w.project, "worker.replay.json"), J([finish]));
  w.qualifyAll();
  w.qual("mock/replay:strong.json", "action-protocol");
  const prompts: string[] = [];
  const env = w.env({
    wrapProvider: (p) => ({
      id: p.id,
      hosted: p.hosted,
      generate: (req) => {
        if (p.id.includes("strong")) prompts.push(req.prompt);
        return p.generate(req);
      },
    }),
  });
  await c.taskCreate(env, w.contract({ budget: "standard" }));
  await c.taskRun(env, "fix-value");
  assert.equal(c.statusOf(env, "fix-value").state, "AWAITING_ACCEPTANCE");
  assert.match(prompts[0]!, /Gate failure/);
  assert.deepEqual(JSON.parse(w.out.at(-1)!).workers, ["mock/replay:worker.replay.json", "mock/replay:strong.json"]);
});

test("blocking review repairs use new action IDs and include findings", async () => {
  const w = world();
  writeFileSync(join(w.project, "worker.replay.json"), J([edit, finish, finish]));
  writeFileSync(
    join(w.project, "reviewer.replay.json"),
    J([
      J({
        findings: [
          {
            severity: "blocking",
            criterion: "correct",
            location: "value.txt",
            evidence: "REVIEW_FEEDBACK",
            consequence: "recheck",
          },
        ],
      }),
      J({ findings: [] }),
    ]),
  );
  w.qualifyAll();
  const prompts: string[] = [];
  const env = w.env({
    wrapProvider: (p) => ({
      id: p.id,
      hosted: p.hosted,
      generate: (req) => {
        if (p.id.includes("worker")) prompts.push(req.prompt);
        return p.generate(req);
      },
    }),
  });
  await c.taskCreate(env, w.contract({ riskTier: "R2", budget: "standard" }));
  await c.taskRun(env, "fix-value");
  await c.taskApprove(env, "fix-value");
  await c.taskRun(env, "fix-value");
  assert.equal(c.statusOf(env, "fix-value").state, "AWAITING_ACCEPTANCE");
  assert.match(prompts.at(-1)!, /REVIEW_FEEDBACK/);
  assert.doesNotMatch(readFileSync(join(w.home, "tasks/fix-value/state/events.jsonl"), "utf8"), /duplicate action id/);
});

test("Jev key alone makes no calls; explicit opt-in is required", async () => {
  const w = world({ policy: { egress: "hosted-allowed" } });
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());
  const calls = { n: 0 };
  await c.taskRun(
    w.env({ secrets: { JEV_API_KEY: "k" }, jevTransport: jevFake(() => "standard-worker", 0.99, calls) }),
    "fix-value",
  );
  assert.equal(calls.n, 0);
  assert.equal(existsSync(join(w.home, "telemetry/jev.jsonl")), false);
});
