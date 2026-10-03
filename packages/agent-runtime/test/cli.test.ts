import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
      enabled: true,
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

test("handoff discovery reports the same project-scoped path in CLI and doctor", async () => {
  const w = world({ extraProfiles: { handoff: { kind: "manual", dir: tmp(), label: "chat" } } });
  const cli = spawnSync(process.execPath, [resolve("src/cli/main.ts"), "handoff-path", "--project", w.project], {
    env: { ...process.env, AGENTIC_HOME: w.home },
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  const { directory } = JSON.parse(cli.stdout);
  assert.equal(directory, c.handoffDirectory(w.env()));
  assert.notEqual(directory, c.handoffDirectory(w.env({ project: tmp() })));
  await c.doctor(w.env());
  assert(w.out.some((line) => line.includes("handoff directory") && line.includes(directory)));
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

test("R0 recipe runs with no model configured at all, including files larger than model context", async () => {
  const w = world();
  writeFileSync(join(w.project, "value.txt"), "bad" + "x".repeat(20_000));
  writeFileSync(
    join(w.project, "check.mjs"),
    'import {readFileSync} from "node:fs"; console.log("tests 1"); process.exit(readFileSync("value.txt","utf8").startsWith("good") ? 0 : 1)',
  );
  writeFileSync(join(w.project, ".agents/models.json"), "{}"); // would be invalid if loaded as models
  await c.taskCreate(
    w.env(),
    w.contract({ riskTier: "R0", scope: ["value.txt"], recipe: { path: "value.txt", find: "bad", replace: "good" } }),
  );

  assert.equal(await c.taskPreflight(w.env(), "fix-value"), 0);
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
test("workflow switch: absent means OFF; enable is explicit and scoped to the project", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());
  const policyFile = join(w.project, ".agents/policy.json");
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  delete policy.enabled;
  writeFileSync(policyFile, J(policy));
  assert.equal(c.workflowEnabled(w.env()), false);
  await c.doctor(w.env());
  assert.match(w.out.join("\n"), /workflow\s+OFF/);
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

test("legacy external routes refuse before calls; explicit delegation is visible in preflight and logs", async () => {
  const w = world({
    extraProfiles: { external: { kind: "claude-cli", model: "test-sonnet" } },
    roles: { worker: "external" },
  });
  await c.taskCreate(w.env(), w.contract());
  let calls = 0;
  const env = w.env({
    wrapProvider: (p) => ({
      ...p,
      id: p.id,
      hosted: false,
      generate: async () => {
        calls++;
        return {
          content: edit.replace('"kind":"edit"', '"kind":"edit_and_finish"'),
          usage: { input: 10, output: 10 },
          finishReason: "stop",
          latencyMs: 0,
        };
      },
    }),
  });
  await assert.rejects(c.taskRun(env, "fix-value"), /requires execution: delegated/);
  await assert.rejects(c.qualify(env, "external"), /requires execution: delegated/);
  assert.equal(calls, 0);
  assert.equal(existsSync(join(w.home, "tasks/fix-value/candidate")), false);
  const file = join(w.project, ".agents/models.json");
  const models = JSON.parse(readFileSync(file, "utf8"));
  models.execution = "delegated";
  writeFileSync(file, J(models));
  await c.qualify(env, "external", "action-protocol");
  assert.equal(await c.taskPreflight(env, "fix-value"), 0);
  assert.equal(calls, 0);
  assert.equal(await c.taskRun(env, "fix-value"), 0);
  assert.equal(calls, 1);
  assert.match(w.out.join("\n"), /external.*claude.*test-sonnet.*owner-declared/);
  const events = readFileSync(join(w.home, "tasks/fix-value/state/events.jsonl"), "utf8");
  assert.match(events, /"type":"model_call".*"role":"worker".*"qualification":"owner-declared"/);
});

test("upgrade preserves config and history, repairs a stale launcher pin, and handoff completes through the controller", async () => {
  const w = world();
  const runtime = resolve(import.meta.dirname, "..");
  const modelFile = join(w.project, ".agents/models.json");
  const original = readFileSync(modelFile, "utf8");
  const policyFile = join(w.project, ".agents/policy.json");
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  policy.egress = "hosted-allowed";
  writeFileSync(policyFile, J(policy));
  const oldPolicy = readFileSync(policyFile, "utf8");
  mkdirSync(join(w.project, "scripts"));
  copyFileSync(
    resolve(runtime, "../../project-setup/templates/scripts/agentic.mjs"),
    join(w.project, "scripts/agentic.mjs"),
  );
  writeFileSync(join(w.project, ".agents/runtime.json"), J({ runtimePath: runtime, treeHash: "stale" }));
  const launcher = () =>
    spawnSync(process.execPath, [join(w.project, "scripts/agentic.mjs"), "doctor"], {
      cwd: w.project,
      encoding: "utf8",
      env: { ...process.env, AGENTIC_HOME: w.home },
    });
  assert.notEqual(launcher().status, 0);
  await c.taskCreate(w.env(), w.contract({ riskTier: "R2" }));
  const contract = readFileSync(join(w.home, "tasks/fix-value/contract.json"), "utf8");
  await assert.rejects(c.upgradeRuntime(w.env(), "auto", runtime), /requires --execution/);
  await assert.rejects(c.upgradeRuntime(w.env(), "handoff", join(runtime, "missing")));
  assert.equal(readFileSync(modelFile, "utf8"), original); // failure rolls back
  await c.upgradeRuntime(w.env(), "delegated", runtime);
  assert.deepEqual(JSON.parse(readFileSync(modelFile, "utf8")).roles, JSON.parse(original).roles);
  await c.upgradeRuntime(w.env(), "handoff", runtime);
  const migrated = readFileSync(modelFile, "utf8");
  const models = JSON.parse(migrated);
  assert.deepEqual(models.profiles.worker, JSON.parse(original).profiles.worker);
  assert.equal(readFileSync(policyFile, "utf8"), oldPolicy);
  assert.equal(readFileSync(join(w.home, "tasks/fix-value/contract.json"), "utf8"), contract);
  assert.equal(launcher().status, 0);
  assert.equal(new QualStore(join(w.home, "qualifications.json")).all().length, 0);
  await c.upgradeRuntime(w.env(), "handoff", runtime);
  assert.equal(readFileSync(modelFile, "utf8"), migrated);
  for (const [role, family] of [
    ["worker", "action-protocol"],
    ["architect", "architecture"],
    ["reviewer", "review"],
  ] as const)
    await c.qualify(w.env(), models.roles[role], family);
  const env = w.env({
    out: (s) => {
      w.out.push(s);
      const match = /^handoff (.+): packet (.+)\nSave ONLY JSON to (.+); leave/.exec(s);
      if (!match) return;
      const [, role, packet, reply] = match;
      assert.ok(packet!.startsWith(w.home));
      const payload = readFileSync(packet!, "utf8");
      assert.ok(payload.includes("maxOutputTokens"));
      writeFileSync(
        reply!,
        role!.includes("architect")
          ? plan
          : role!.includes("reviewer")
            ? J({ findings: [] })
            : edit.replace('"kind":"edit"', '"kind":"edit_and_finish"'),
      );
    },
  });
  assert.equal(await c.taskPreflight(env, "fix-value"), 0);
  assert.equal(await c.taskRun(env, "fix-value"), 2);
  assert.equal(await c.taskApprove(env, "fix-value"), 0);
  assert.equal(await c.taskRun(env, "fix-value"), 0);
  assert.equal(c.statusOf(env, "fix-value").state, "AWAITING_ACCEPTANCE");
  assert.equal(readFileSync(join(w.project, "value.txt"), "utf8"), "bad"); // isolated candidate, acceptance still required
});

test("planning uses the selected context limit, and oversize fails before installation or spending", async () => {
  const w = world({ policy: { bootstrap: { argv: [process.execPath, "-e", "process.exit(99)"], timeoutMs: 5000 } } });
  w.qualifyAll();
  writeFileSync(join(w.project, "value.txt"), "x".repeat(65_000));
  let calls = 0;
  const env = w.env({
    wrapProvider: (p) => ({
      id: p.id,
      hosted: p.hosted,
      generate: async (req) => {
        calls++;
        return p.generate(req);
      },
    }),
  });
  await c.taskCreate(env, w.contract({ riskTier: "R2", budget: "complex" }));
  assert.equal(await c.taskRun(env, "fix-value"), 1);
  assert.equal(calls, 0);
  assert.equal(c.statusOf(env, "fix-value").state, "NOT_STARTED");
  assert.equal(existsSync(join(w.home, "tasks/fix-value/candidate")), false);
  assert.match(w.out.join("\n"), /Nothing installed or spent/);
  writeFileSync(join(w.project, "value.txt"), "x".repeat(20_000));
  const policy = JSON.parse(readFileSync(join(w.project, ".agents/policy.json"), "utf8"));
  delete policy.bootstrap;
  writeFileSync(join(w.project, ".agents/policy.json"), J(policy));
  await c.taskRevise(env, "fix-value", w.contract({ riskTier: "R2", budget: "complex" }));
  await c.taskRevise(env, "fix-value", w.contract({ riskTier: "R2", budget: "standard" }));
  assert.equal(await c.taskPreflight(env, "fix-value"), 0);
  assert.equal(await c.taskRun(env, "fix-value"), 2);
  assert.equal(calls, 1); // >4k context fits standard; no artificial planning ceiling
  assert.equal(c.statusOf(env, "fix-value").state, "AWAITING_PLAN_APPROVAL");
});

test("operator revision reuses preparation and edits, retains usage, and requires fresh approval/review", async () => {
  const w = world({
    policy: {
      baseline: "record",
      bootstrap: {
        argv: [
          process.execPath,
          "-e",
          'require("fs").mkdirSync("node_modules",{recursive:true});require("fs").writeFileSync("node_modules/prepared","yes")',
        ],
        timeoutMs: 5000,
      },
    },
  });
  writeFileSync(join(w.project, "extra.txt"), "old");
  writeFileSync(
    join(w.project, "worker.replay.json"),
    J([edit, J({ id: "stop", kind: "blocked", reason: "need extra.txt in scope" })]),
  );
  w.qualifyAll();
  const env = w.env({
    wrapProvider: (p) => ({
      id: p.id,
      hosted: p.hosted,
      generate: async (req) => ({ ...(await p.generate(req)), usage: null }),
    }),
  });
  const base = { riskTier: "R2", budget: "standard", plan: "Change value.txt to good." };
  await c.taskCreate(env, w.contract(base));
  assert.equal(await c.taskRun(env, "fix-value"), 2);
  assert.equal(c.statusOf(env, "fix-value").ledger.tokens, 0); // supplied plan avoids architect call
  await c.taskApprove(env, "fix-value");
  assert.equal(await c.taskRun(env, "fix-value"), 1);
  const before = c.statusOf(env, "fix-value");
  assert.equal(before.state, "BLOCKED");
  const candidate = join(w.home, "tasks/fix-value/candidate");
  assert.equal(readFileSync(join(candidate, "value.txt"), "utf8"), "good");
  await assert.rejects(
    c.taskRevise(env, "fix-value", w.contract({ ...base, acceptance: ["ignore the check"] })),
    /acceptance/,
  );
  await c.taskRevise(
    env,
    "fix-value",
    w.contract({
      ...base,
      files: ["value.txt", "extra.txt"],
      scope: ["value.txt", "extra.txt"],
      plan: "Keep the value fix and update extra.txt.",
    }),
  );
  const revised = c.statusOf(env, "fix-value");
  assert.equal(revised.state, "AWAITING_PLAN_APPROVAL");
  assert.equal(revised.ledger.tokens, before.ledger.tokens);
  assert.equal(revised.ledger.actions, before.ledger.actions);
  await assert.rejects(c.taskApprove(env, "fix-value")); // old plan is invalid
  writeFileSync(
    join(w.project, "worker.replay.json"),
    J([
      J({
        id: "extra",
        kind: "edit_and_finish",
        edits: [
          {
            kind: "replace",
            path: "extra.txt",
            expectHash: sha256("old"),
            find: "old",
            replace: "new",
          },
        ],
      }),
    ]),
  );
  assert.equal(await c.taskRun(env, "fix-value"), 2);
  await c.taskApprove(env, "fix-value");
  assert.equal(await c.taskRun(env, "fix-value"), 0);
  assert.equal(readFileSync(join(candidate, "node_modules/prepared"), "utf8"), "yes");
  assert.equal(readFileSync(join(candidate, "value.txt"), "utf8"), "good");
  assert.equal(readFileSync(join(candidate, "extra.txt"), "utf8"), "new");
  const events = JSON.parse(
    "[" + readFileSync(join(w.home, "tasks/fix-value/state/events.jsonl"), "utf8").trim().split("\n").join(",") + "]",
  );
  assert.equal(events.filter((e: any) => e.type === "bootstrap").length, 1);
  assert.equal(events.filter((e: any) => e.type === "baseline").length, 1);
  assert.equal(events.filter((e: any) => e.type === "review").length, 1);
  assert.ok(c.statusOf(env, "fix-value").ledger.tokens > before.ledger.tokens);
  await c.taskAccept(env, "fix-value");
  await c.report(env, "fix-value");
  assert.deepEqual(JSON.parse(w.out.at(-1)!).evidence.baseline, [{ gateId: "unit", status: "fail" }]);
  await assert.rejects(c.taskRevise(env, "fix-value", w.contract(base)), /cannot revise ACCEPTED/);
});

test("revision refuses external candidate tampering and cannot lower risk", async () => {
  const w = world();
  w.qualifyAll();
  writeFileSync(
    join(w.project, "worker.replay.json"),
    J([J({ id: "stop", kind: "blocked", reason: "need more context" })]),
  );
  await c.taskCreate(w.env(), w.contract());
  await c.taskRun(w.env(), "fix-value");
  await assert.rejects(c.taskRevise(w.env(), "fix-value", w.contract({ riskTier: "R0" })), /cannot lower risk/);
  writeFileSync(join(w.home, "tasks/fix-value/candidate/check.mjs"), "weakened");
  await assert.rejects(c.taskRevise(w.env(), "fix-value", w.contract({ budget: "standard" })), /externally modified/);
});

test("full Stop-hook verification is a separate opt-in; explicit checks remain available", async () => {
  const w = world({ policy: { enabled: false } });
  spawnSync("git", ["init", "-q"], { cwd: w.project });
  assert.equal(await c.sessionCheckCmd(w.env(), false, true), 0);
  assert.equal(existsSync(join(w.home, "sessions.jsonl")), false);
  assert.equal(await c.sessionCheckCmd(w.env()), 2); // explicit check works with managed execution off
  const sessions = () => readFileSync(join(w.home, "sessions.jsonl"), "utf8").trim().split("\n").length;
  assert.equal(sessions(), 1);
  await c.enableWorkflow(w.env());
  assert.equal(await c.sessionCheckCmd(w.env(), false, true), 0);
  assert.equal(sessions(), 1);
  const file = join(w.project, ".agents/policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  policy.sessionChecks = true;
  writeFileSync(file, J(policy));
  assert.equal(await c.sessionCheckCmd(w.env(), false, true), 2);
  assert.equal(sessions(), 2);
});

test("tasks and switches are isolated between projects sharing one controller home", async () => {
  const a = world(),
    b = world();
  await c.taskCreate(a.env(), a.contract());
  await c.disableWorkflow(a.env());
  assert.equal(c.workflowEnabled(b.env()), true);
  await assert.rejects(c.taskPreflight(b.env({ home: a.home }), "fix-value"), /another project\/worktree/);
});

test("revision cannot reuse a baseline after project gates or policy were changed", async () => {
  const w = world();
  w.qualifyAll();
  writeFileSync(
    join(w.project, "worker.replay.json"),
    J([J({ id: "stop", kind: "blocked", reason: "need scope adjustment" })]),
  );
  await c.taskCreate(w.env(), w.contract());
  await c.taskRun(w.env(), "fix-value");
  const file = join(w.project, ".agents/policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  policy.gates[0].argv = [process.execPath, "-e", 'console.log("tests 1")'];
  writeFileSync(file, J(policy));
  await assert.rejects(
    c.taskRevise(w.env(), "fix-value", w.contract({ budget: "standard" })),
    /changed project policy/,
  );
});

test("standard budget supports a gate repair followed by a blocking-review repair without restarting", async () => {
  const w = world();
  writeFileSync(
    join(w.project, "worker.replay.json"),
    J([finish, edit.replace('"kind":"edit"', '"kind":"edit_and_finish"'), finish]),
  );
  writeFileSync(
    join(w.project, "reviewer.replay.json"),
    J([
      J({
        findings: [
          {
            severity: "blocking",
            criterion: "correct",
            location: "value.txt",
            evidence: "recheck",
            consequence: "review again",
          },
        ],
      }),
      J({ findings: [] }),
    ]),
  );
  w.qualifyAll();
  const providers = new Map<string, any>();
  const env = w.env({
    wrapProvider: (p) => {
      if (!providers.has(p.id)) providers.set(p.id, p);
      return providers.get(p.id);
    },
  });
  await c.taskCreate(env, w.contract({ riskTier: "R2", budget: "standard", plan: "Change the value and verify it." }));
  await c.taskRun(env, "fix-value");
  await c.taskApprove(env, "fix-value");
  await c.taskRun(env, "fix-value");
  await c.taskRun(env, "fix-value");
  const status = c.statusOf(env, "fix-value");
  assert.equal(status.state, "AWAITING_ACCEPTANCE");
  assert.equal(status.ledger.repairs, 2);
});

test("task start runs an agreed contract directly and preserves approval/acceptance boundaries", async () => {
  for (const riskTier of ["R1", "R2"]) {
    const w = world();
    w.qualifyAll();
    const roles: string[] = [];
    const env = w.env({
      wrapProvider: (p) => {
        return {
          id: p.id,
          hosted: p.hosted,
          generate: async (req) => {
            roles.push(p.id);
            return p.generate(req);
          },
        };
      },
    });
    const file = w.contract({ riskTier, budget: "standard", plan: "Change bad to good and run the unit gate." });
    assert.equal(await c.taskStart(env, file), riskTier === "R1" ? 0 : 2);
    if (riskTier === "R2") {
      assert.equal(c.statusOf(env, "fix-value").state, "AWAITING_PLAN_APPROVAL");
      assert.equal(roles.length, 0);
      await c.taskApprove(env, "fix-value");
      assert.equal(await c.taskRun(env, "fix-value"), 0);
      assert.ok(roles.some((id) => id.includes("reviewer")));
    }
    assert.equal(c.statusOf(env, "fix-value").state, "AWAITING_ACCEPTANCE");
    assert.ok(!roles.some((id) => id.includes("architect")));
    assert.equal(readFileSync(join(w.project, "value.txt"), "utf8"), "bad");
    await assert.rejects(c.taskStart(env, file), /already exists/);
  }
});

test("task start refuses disabled execution and preflight failure before candidate/model work", async () => {
  const off = world({ policy: { enabled: false } });
  await assert.rejects(c.taskStart(off.env(), off.contract()), /off/);
  assert.equal(existsSync(join(off.home, "tasks/fix-value")), false);
  const w = world();
  await assert.rejects(c.taskStart(w.env(), w.contract()), /unsupported capability/);
  assert.equal(existsSync(join(w.home, "tasks/fix-value/candidate")), false);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "NOT_STARTED");
});

test("new tasks default to uncapped tokens while explicit caps survive serialization", async () => {
  for (const budget of ["narrow", "standard", "complex"]) {
    const w = world();
    await c.taskCreate(w.env(), w.contract({ budget }));
    const saved = JSON.parse(readFileSync(join(w.home, "tasks/fix-value/contract.json"), "utf8"));
    assert.equal(saved.limits.aggregateTokens, undefined);
    w.qualifyAll();
    await c.taskPreflight(w.env(), "fix-value");
    assert.ok(w.out.some((line) => line.includes("uncapped tokens")));
  }
  const w = world();
  await c.taskCreate(
    w.env(),
    w.contract({ limits: { aggregateTokens: 1_000_000, toolActions: 24, semanticRepairs: 3 } }),
  );
  const saved = JSON.parse(readFileSync(join(w.home, "tasks/fix-value/contract.json"), "utf8"));
  assert.equal(saved.limits.aggregateTokens, 1_000_000);
  assert.equal(await c.validateFiles(w.env(), [w.contract({ limits: { toolActions: 24, semanticRepairs: 3 } })]), 0);
  assert.equal(
    await c.validateFiles(w.env(), [
      w.contract({ limits: { aggregateTokens: -1, toolActions: 24, semanticRepairs: 3 } }),
    ]),
    1,
  );
});

test("uncapped worker and reviewer usage is recorded past one million tokens", async () => {
  const w = world();
  w.qualifyAll();
  const env = w.env({
    wrapProvider: (provider) => ({
      id: provider.id,
      hosted: provider.hosted,
      generate: async (request) => ({
        ...(await provider.generate(request)),
        usage: { input: 2_000_000, output: 100 },
      }),
    }),
  });
  await c.taskCreate(env, w.contract({ riskTier: "R2", plan: "Change value.txt to good." }));
  assert.equal(await c.taskRun(env, "fix-value"), 2);
  await c.taskApprove(env, "fix-value");
  assert.equal(await c.taskRun(env, "fix-value"), 0);
  assert.equal(c.statusOf(env, "fix-value").state, "AWAITING_ACCEPTANCE");
  assert.ok(c.statusOf(env, "fix-value").ledger.tokens > 4_000_000);
});

test("authorized revision removes a numeric cap without resetting usage or allowing a lower limit", async () => {
  const w = world();
  w.qualifyAll();
  writeFileSync(
    join(w.project, "worker.replay.json"),
    J([edit, J({ id: "stop", kind: "blocked", reason: "operator revision" })]),
  );
  const env = w.env();
  const limited = { aggregateTokens: 100_000, toolActions: 6, semanticRepairs: 1 };
  await c.taskCreate(env, w.contract({ limits: limited }));
  assert.equal(await c.taskRun(env, "fix-value"), 1);
  const before = c.statusOf(env, "fix-value").ledger.tokens;
  await c.taskRevise(env, "fix-value", w.contract({ limits: { toolActions: 6, semanticRepairs: 1 } }));
  assert.equal(c.statusOf(env, "fix-value").ledger.tokens, before);
  await assert.rejects(c.taskRevise(env, "fix-value", w.contract({ limits: limited })), /cannot lower aggregateTokens/);
  writeFileSync(join(w.project, "worker.replay.json"), J([finish]));
  const highUsage = w.env({
    wrapProvider: (provider) => ({
      id: provider.id,
      hosted: provider.hosted,
      generate: async (request) => ({
        ...(await provider.generate(request)),
        usage: { input: 2_000_000, output: 100 },
      }),
    }),
  });
  assert.equal(await c.taskRun(highUsage, "fix-value"), 0);
  assert.ok(c.statusOf(env, "fix-value").ledger.tokens > before + 2_000_000);
});

test("R2 supplied plans consult Jev once without skipping approval or review", async () => {
  const w = world({ policy: jevPolicy("enabled", { allowUncalibrated: true }) });
  w.qualifyAll();
  const calls = { n: 0 };
  const env = w.env({ jevTransport: jevFake(() => "standard-worker", 0.99, calls) });
  await c.taskCreate(env, w.contract({ riskTier: "R2", plan: "Change value.txt to good." }));
  assert.equal(await c.taskRun(env, "fix-value"), 2);
  assert.equal(calls.n, 1);
  assert.equal(c.statusOf(env, "fix-value").state, "AWAITING_PLAN_APPROVAL");
  assert.equal(c.statusOf(env, "fix-value").ledger.tokens, 0);
  await c.taskApprove(env, "fix-value");
  assert.equal(await c.taskRun(env, "fix-value"), 0);
  assert.equal(calls.n, 1);
  assert.equal(c.statusOf(env, "fix-value").state, "AWAITING_ACCEPTANCE");
});

test("R2 Jev clarification blocks before supplied plan approval or native calls", async () => {
  const w = world({ policy: jevPolicy("enabled", { allowUncalibrated: true }) });
  w.qualifyAll();
  const calls = { n: 0 };
  const env = w.env({ jevTransport: jevFake(() => "ask-clarification", 0.99, calls) });
  await c.taskCreate(env, w.contract({ riskTier: "R2", plan: "Change value.txt to good." }));
  assert.equal(await c.taskRun(env, "fix-value"), 2);
  assert.equal(calls.n, 1);
  assert.equal(c.statusOf(env, "fix-value").state, "NEEDS_INPUT");
  assert.equal(c.statusOf(env, "fix-value").ledger.tokens, 0);
});
