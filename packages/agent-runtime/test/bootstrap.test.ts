import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as c from "../src/cli/commands.ts";
import { type Policy, Run } from "../src/run.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "bs-"));
function setup(check: string, over: Partial<Policy> = {}) {
  const base = tmp(), ws = join(base, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "check.mjs"), check);
  const policy: Policy = {
    workspace: ws, stateDir: join(base, "state"), protectedPaths: ["check.mjs"], riskTier: "R1", egress: "local-only", isolation: "none",
    gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 8000, discover: { regex: "tests (\\d+)", min: 1 } }],
    requiredGates: ["unit"], limits: { aggregateTokens: 1000, toolActions: 5, semanticRepairs: 1 }, ...over,
  };
  return { policy, ws };
}
const boot = (script: string) => ({ id: "bootstrap", argv: ["node", "-e", script], timeoutMs: 8000, discover: { regex: "", min: 0 }, env: { PILOT_MARK: "from-policy" } });

test("bootstrap runs once before anything else; its output is not part of the candidate diff", async () => {
  const { policy, ws } = setup(`import {existsSync} from "node:fs"; console.log("tests 1"); process.exit(existsSync("node_modules/ok")?0:1)`,
    { bootstrap: boot(`require("fs").mkdirSync("node_modules",{recursive:true});require("fs").writeFileSync("node_modules/ok",process.env.PILOT_MARK)`), baseline: "require-pass" });
  const run = new Run(policy);
  await run.prepare();
  run.start();
  assert.equal(run.state, "IMPLEMENTING");
  assert.equal(readFileSync(join(ws, "node_modules/ok"), "utf8"), "from-policy");
  assert.deepEqual(run.changed(), []);
});

test("failing bootstrap → BLOCKED (environment failure); gates never run", async () => {
  const { policy } = setup(`console.log("tests 1")`, { bootstrap: boot(`process.exit(3)`), baseline: "require-pass" });
  const run = new Run(policy);
  await run.prepare();
  run.start();
  assert.equal(run.state, "BLOCKED");
});

test("baseline: pre-existing failure stops the task; 'record' keeps going and records it in evidence", async () => {
  const failing = `console.log("tests 1"); process.exit(1)`;
  const a = setup(failing, { baseline: "require-pass" });
  const ra = new Run(a.policy);
  await ra.prepare();
  ra.start();
  assert.equal(ra.state, "NEEDS_INPUT");
  const b = setup(`import {existsSync} from "node:fs"; console.log("tests 1"); process.exit(existsSync("fixed")?0:1)`, { baseline: "record" });
  const rb = new Run(b.policy);
  await rb.prepare();
  rb.start();
  assert.equal(rb.state, "IMPLEMENTING");
  await rb.handle({ id: "e1", kind: "edit", edits: [{ kind: "create", path: "fixed", content: "x" }] });
  await rb.handle({ id: "f1", kind: "finish" });
  assert.deepEqual(rb.evidence?.baseline, [{ gateId: "unit", status: "fail" }]);
});

test("nothing executes before isolation is decided or for R3-without-isolation", async () => {
  const marker = "bootstrap-ran";
  for (const over of [{ isolation: "unset" as const }, { riskTier: "R3" as const }]) {
    const { policy, ws } = setup(`console.log("tests 1")`, { ...over, bootstrap: boot(`require("fs").writeFileSync("${marker}","x")`), baseline: "require-pass" });
    const run = new Run(policy);
    await run.prepare();
    assert.equal(existsSync(join(ws, marker)), false, JSON.stringify(over));
    run.start();
    assert.notEqual(run.state, "IMPLEMENTING");
  }
});

test("project copy follows git: ignored files (.env, build output) are not copied; untracked files are", async () => {
  const project = tmp(), home = tmp();
  const git = (...a: string[]) => spawnSync("git", a, { cwd: project, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(project, ".gitignore"), ".env\nbuild/\n");
  mkdirSync(join(project, "build"));
  writeFileSync(join(project, "build/big.bin"), "x");
  writeFileSync(join(project, ".env"), "SECRET=1");
  writeFileSync(join(project, "tracked.txt"), "t");
  git("add", "-A"); git("-c", "user.email=a@b", "-c", "user.name=n", "commit", "-qm", "init");
  writeFileSync(join(project, "untracked.txt"), "u");
  mkdirSync(join(project, ".agents"));
  writeFileSync(join(project, ".agents/policy.json"), JSON.stringify({ schemaVersion: 1, protectedPaths: [], egress: "local-only", gates: [{ id: "g", argv: ["node", "-e", "console.log('tests 1')"], timeoutMs: 5000, discover: { regex: "tests (\\d+)", min: 1 } }], requiredGates: ["g"], baseline: "off" }));
  writeFileSync(join(project, ".agents/models.json"), JSON.stringify({ schemaVersion: 1, profiles: { w: { kind: "replay", file: join(project, "w.json") } }, roles: { worker: "w" } }));
  writeFileSync(join(project, "w.json"), JSON.stringify([JSON.stringify({ id: "a", kind: "finish" })]));
  const contract = join(tmp(), "c.json");
  writeFileSync(contract, JSON.stringify({ schemaVersion: 1, id: "copy-check", goal: "check the copy", acceptance: ["gate passes"], files: ["tracked.txt"], riskTier: "R1", budget: "narrow" }));
  const out: string[] = [];
  const env = (): c.Env => ({ home, project, out: (s) => out.push(s), operatorTty: true, ask: async () => "no", user: "t", dockerUp: () => false });
  new (await import("../src/qualify.ts")).QualStore(join(home, "qualifications.json")).record({ profileId: "mock/replay:w.json", family: "action-protocol", source: "owner-declared", passed: true, detail: {}, at: "t" });
  await c.taskCreate(env(), contract);
  await c.taskRun(env(), "copy-check");
  const cand = join(home, "tasks/copy-check/candidate");
  assert.ok(existsSync(join(cand, "tracked.txt")) && existsSync(join(cand, "untracked.txt")));
  assert.equal(existsSync(join(cand, ".env")), false);
  assert.equal(existsSync(join(cand, "build")), false);
  assert.equal(existsSync(join(cand, ".git")), false);
});
