import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { type CaseResult, compare, GATE, grade, loadSuite, summarize, validateCase } from "../src/eval.ts";

const evals = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "evals");
const cases = loadSuite(evals, "dev-r1");
const holdout = loadSuite(evals, "holdout-r1");

test("suite loads: every case has a family, an expectation and a contract that fits the schema's shape", () => {
  assert.equal(cases.length, 8);
  for (const c of cases) {
    assert.ok(c.family && ["accepted", "abstain"].includes(c.expect), c.id);
    assert.ok(c.contract.acceptance.length > 0 && c.contract.files.length > 0, c.id);
  }
});

for (const c of cases) {
  test(`fixture audit: ${c.id} — untouched fixture fails its grader; reference passes it`, () => {
    assert.deepEqual(validateCase(c), []);
  });
}

for (const c of holdout) {
  test(`holdout fixture audit: ${c.id}`, () => assert.deepEqual(validateCase(c), []));
}

test("a defective case is caught: a grader that accepts the untouched fixture is reported", () => {
  const src = cases.find((c) => c.id === "add-clamp")!;
  const dir = mkdtempSync(join(tmpdir(), "bad-case-"));
  cpSync(src.dir, dir, { recursive: true });
  writeFileSync(join(dir, "grader", "grade.mjs"), "process.exit(0)");
  const problems = validateCase({ ...src, dir });
  assert.ok(problems.some((p) => /already passes the grader/.test(p)));
});

test("grader catches a plausible wrong fix that the visible tests also accept", () => {
  const c = cases.find((x) => x.id === "fix-slugify")!;
  const dir = mkdtempSync(join(tmpdir(), "wrong-fix-"));
  cpSync(join(c.dir, "project"), dir, { recursive: true });
  // passes the 3 visible tests but mishandles underscores/dots (hidden grader cases)
  writeFileSync(join(dir, "src/slugify.mjs"), `export function slugify(t){return t.toLowerCase().replace(/[ ,!-]+/g,"-").replace(/^-+|-+$/g,"")}`);
  assert.equal(grade(c, dir), false);
});

const r = (o: Partial<CaseResult>): CaseResult => ({ caseId: "x", family: "f", expect: "accepted", trial: 1, profile: "p", state: "AWAITING_ACCEPTANCE", runtimeAccepted: true, independentlyCorrect: true, abstained: false, falseAcceptance: false, safetyFailure: false, correctAbstention: false, unnecessaryAbstention: false, tokens: 1000, costUsd: 0.01, wallMs: 1000, unknownUsageCalls: 0, ...o });

test("metrics: cost per accepted task counts ALL attempts; zero accepted → undefined, not zero", () => {
  const s = summarize([r({}), r({ runtimeAccepted: false, independentlyCorrect: null, state: "ESCALATED", abstained: true, unnecessaryAbstention: true, costUsd: 0.03 })]);
  assert.equal(s.acceptedCorrect, 1);
  assert.ok(Math.abs(s.costPerAcceptedTask! - 0.04) < 1e-9);
  const none = summarize([r({ runtimeAccepted: false, independentlyCorrect: null, state: "BLOCKED", abstained: true, costUsd: 0.02 })]);
  assert.equal(none.costPerAcceptedTask, null);
});

test("metrics: runtime acceptance of an incorrect result is a false acceptance; accepting an abstain-expected case is a safety failure", () => {
  const s = summarize([r({ independentlyCorrect: false, falseAcceptance: true }), r({ expect: "abstain", safetyFailure: true, independentlyCorrect: true })]);
  assert.equal(s.falseAcceptances, 1);
  assert.equal(s.safetyFailures, 1);
  assert.equal(s.acceptedCorrect, 0); // an abstain-expected case never counts as an accepted task
  assert.match(compare([r({})], [r({})]), /Small samples show feasibility/);
});

test("the eval gate's discovery regex matches real `node --test` output for every accept-case (red and green)", () => {
  for (const c of cases.filter((x) => x.expect === "accepted")) {
    for (const overlay of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "gate-rx-"));
      cpSync(join(c.dir, "project"), dir, { recursive: true });
      if (overlay) cpSync(join(c.dir, "reference"), dir, { recursive: true });
      const out = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" } }).stdout;
      const m = new RegExp(GATE.discover.regex).exec(out);
      assert.ok(m && Number(m[1]) >= 1, `${c.id} (${overlay ? "fixed" : "initial"}): discovery found nothing`);
    }
  }
});
