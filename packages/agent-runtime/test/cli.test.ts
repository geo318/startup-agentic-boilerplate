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
const edit = J({ id: "x", kind: "edit", edits: [{ kind: "replace", path: "value.txt", expectHash: sha256("bad"), find: "bad", replace: "good" }] });
const finish = J({ id: "y", kind: "finish" });
const plan = J({ decisions: ["d"], assumptions: ["a"], interfaces: ["i"], failureModes: ["f"], steps: ["fix value"] });

function world(over: { policy?: object; roles?: object; extraProfiles?: object } = {}) {
  const project = tmp(), home = tmp();
  mkdirSync(join(project, ".agents"));
  writeFileSync(join(project, "value.txt"), "bad");
  writeFileSync(join(project, "check.mjs"), `import {readFileSync} from "node:fs"; console.log("tests 1"); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`);
  const script = (name: string, items: string[]) => { const f = join(project, `${name}.replay.json`); writeFileSync(f, J(items)); return f; };
  const profiles = {
    worker: { kind: "replay", file: script("worker", [edit, finish]) },
    architect: { kind: "replay", file: script("architect", [plan]) },
    reviewer: { kind: "replay", file: script("reviewer", [J({ findings: [] })]) },
    ...(over.extraProfiles ?? {}),
  };
  writeFileSync(join(project, ".agents/models.json"), J({ schemaVersion: 1, profiles, roles: { worker: "worker", architect: "architect", reviewer: "reviewer", ...(over.roles ?? {}) } }));
  writeFileSync(join(project, ".agents/policy.json"), J({
    schemaVersion: 1, protectedPaths: ["check.mjs", ".agents"], egress: "local-only", baseline: "off",
    gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 8000, discover: { regex: "tests (\\d+)", min: 1 } }], requiredGates: ["unit"], ...(over.policy ?? {}),
  }));
  const out: string[] = [];
  const answers: string[] = [];
  const env = (o: Partial<c.Env> = {}): c.Env => ({ home, project, out: (s) => out.push(s), operatorTty: true, ask: async () => answers.shift() ?? "", user: "tester", dockerUp: () => false, ...o });
  const qual = (id: string, family: "action-protocol" | "architecture" | "review") =>
    new QualStore(join(home, "qualifications.json")).record({ profileId: id, family, source: "owner-declared", passed: true, detail: {}, at: "t" });
  const contract = (o: object = {}) => {
    const f = join(tmp(), "contract.json");
    writeFileSync(f, J({ schemaVersion: 1, id: "fix-value", goal: "make value.txt say good", acceptance: ["check.mjs exits 0"], files: ["value.txt"], riskTier: "R1", budget: "narrow", ...o }));
    return f;
  };
  const qualifyAll = () => { qual("mock/replay:worker.replay.json", "action-protocol"); qual("mock/replay:architect.replay.json", "architecture"); qual("mock/replay:reviewer.replay.json", "review"); };
  return { project, home, out, answers, env, contract, qual, qualifyAll };
}

test("schema validator: closed objects, enums, patterns; unknown keywords refuse to load", () => {
  const s = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string", pattern: "^x" }, b: { enum: [1, 2] } } };
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

test("R1 happy path: needs isolation answer; routes only qualified; operator-only accept; isolated candidate; patch applies", async () => {
  const w = world();
  assert.equal(await c.taskCreate(w.env(), w.contract()), 0);
  // no terminal: nothing runs, nothing created
  assert.equal(await c.taskRun(w.env({ operatorTty: false }), "fix-value"), 2);
  assert.equal(existsSync(join(w.home, "tasks/fix-value/candidate")), false);
  // unqualified worker → refused before any state exists
  w.answers.push("no");
  await assert.rejects(c.taskRun(w.env(), "fix-value"), /unsupported capability.*qualify/);
  assert.equal(existsSync(join(w.home, "tasks/fix-value/candidate")), false);
  w.qualifyAll();
  assert.equal(await c.taskRun(w.env(), "fix-value"), 0);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_ACCEPTANCE");
  assert.equal(readFileSync(join(w.project, "value.txt"), "utf8"), "bad"); // project untouched
  assert.equal(readFileSync(join(w.home, "tasks/fix-value/candidate/value.txt"), "utf8"), "good");
  // acceptance needs a human at a terminal, and a literal yes
  await assert.rejects(c.taskAccept(w.env({ operatorTty: false }), "fix-value"), (e: any) => e.code === 3);
  w.answers.push("sure");
  assert.equal(await c.taskAccept(w.env(), "fix-value"), 1);
  w.answers.push("yes");
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
  w.answers.push("no");
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
  w.answers.push("no");
  assert.equal(await c.taskRun(w.env(), "fix-value"), 2);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_PLAN_APPROVAL");
  assert.equal(readFileSync(join(w.home, "tasks/fix-value/candidate/value.txt"), "utf8"), "bad");
  await assert.rejects(c.taskApprove(w.env({ operatorTty: false }), "fix-value"), (e: any) => e.code === 3);
  w.answers.push("no");
  assert.equal(await c.taskApprove(w.env(), "fix-value"), 1); // declined
  w.answers.push("yes");
  assert.equal(await c.taskApprove(w.env(), "fix-value"), 0);
  assert.equal(await c.taskRun(w.env(), "fix-value"), 0);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "AWAITING_ACCEPTANCE");
  const rep = JSON.parse((w.out.length, (await c.report(w.env(), "fix-value"), w.out.at(-1)!)));
  assert.equal(rep.evidence.tier, "R2");
  assert.ok(rep.evidence.planHash);
});

test("plan file tampering after it was written is detected at approval", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract({ riskTier: "R2", budget: "standard" }));
  w.answers.push("no");
  await c.taskRun(w.env(), "fix-value");
  const f = join(w.home, "tasks/fix-value/plan.json");
  const p = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, J({ ...p, text: p.text.replace("fix value", "delete everything") }));
  w.answers.push("yes");
  await assert.rejects(c.taskApprove(w.env(), "fix-value"), /modified after/);
});

test("risk floor from declared scope raises the tier; R3 + no isolation is blocked", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract({ scope: ["db/migrations/002.sql"] }));
  w.answers.push("no");
  assert.equal(await c.taskRun(w.env(), "fix-value"), 1);
  assert.equal(c.statusOf(w.env(), "fix-value").state, "BLOCKED");
});

test("hosted profile under local-only policy is blocked before anything leaves", async () => {
  const w = world({ extraProfiles: { handoff: { kind: "manual", dir: tmp(), label: "chat" } }, roles: { worker: "handoff" } });
  w.qual("manual/chat", "action-protocol");
  await c.taskCreate(w.env(), w.contract());
  w.answers.push("no");
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
  w2.answers.push("no");
  await c.taskRun(w2.env(), "fix-value");
  assert.equal(await c.taskCancel(w2.env(), "fix-value"), 0);
  assert.equal(await c.taskRun(w2.env(), "fix-value"), 1);
});

test("R0 recipe runs with no model configured at all", async () => {
  const w = world();
  writeFileSync(join(w.project, ".agents/models.json"), "{}"); // would be invalid if loaded as models
  await c.taskCreate(w.env(), w.contract({ riskTier: "R0", scope: ["value.txt"], recipe: { path: "value.txt", find: "bad", replace: "good" } }));
  w.answers.push("no");
  assert.equal(await c.taskRun(w.env(), "fix-value"), 0);
  assert.equal(c.statusOf(w.env(), "fix-value").ledger.tokens, 0);
});

test("qualify: owner-declared needs a terminal and a literal yes", async () => {
  const w = world();
  await assert.rejects(c.qualify(w.env({ operatorTty: false }), "reviewer", "review"), (e: any) => e.code === 3);
  w.answers.push("no");
  assert.equal(await c.qualify(w.env(), "reviewer", "review"), 1);
  w.answers.push("yes");
  assert.equal(await c.qualify(w.env(), "reviewer", "review"), 0);
  assert.equal(new QualStore(join(w.home, "qualifications.json")).has("mock/replay:reviewer.replay.json", "review"), true);
});

test("verify: re-runs the gates on the exact candidate; detects tampering afterwards; changes no state", async () => {
  const w = world();
  w.qualifyAll();
  await c.taskCreate(w.env(), w.contract());
  w.answers.push("no");
  await c.taskRun(w.env(), "fix-value");
  const before = c.statusOf(w.env(), "fix-value");
  assert.equal(await c.verifyTask(w.env(), "fix-value"), 0);
  assert.match(w.out.at(-1)!, /^verified:/);
  assert.deepEqual(c.statusOf(w.env(), "fix-value").state, before.state);
  writeFileSync(join(w.home, "tasks/fix-value/candidate/value.txt"), "good, then edited");
  assert.equal(await c.verifyTask(w.env(), "fix-value"), 1);
  assert.match(w.out.at(-1)!, /candidate changed/);
});
