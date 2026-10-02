import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(
    join(dir, "src/slugify.mjs"),
    `export function slugify(t){return t.toLowerCase().replace(/[ ,!-]+/g,"-").replace(/^-+|-+$/g,"")}`,
  );
  assert.equal(grade(c, dir), false);
});

const r = (o: Partial<CaseResult>): CaseResult => ({
  caseId: "x",
  family: "f",
  expect: "accepted",
  trial: 1,
  profile: "p",
  state: "AWAITING_ACCEPTANCE",
  runtimeAccepted: true,
  independentlyCorrect: true,
  abstained: false,
  falseAcceptance: false,
  safetyFailure: false,
  correctAbstention: false,
  unnecessaryAbstention: false,
  tokens: 1000,
  costUsd: 0.01,
  wallMs: 1000,
  unknownUsageCalls: 0,
  unknownCostCalls: 0,
  qualificationCostUsd: 0,
  ...o,
});

test("metrics: cost per accepted task counts ALL attempts; zero accepted → undefined, not zero", () => {
  const s = summarize([
    r({}),
    r({
      runtimeAccepted: false,
      independentlyCorrect: null,
      state: "ESCALATED",
      abstained: true,
      unnecessaryAbstention: true,
      costUsd: 0.03,
    }),
  ]);
  assert.equal(s.acceptedCorrect, 1);
  assert.ok(Math.abs(s.costPerAcceptedTask! - 0.04) < 1e-9);
  const none = summarize([
    r({ runtimeAccepted: false, independentlyCorrect: null, state: "BLOCKED", abstained: true, costUsd: 0.02 }),
  ]);
  assert.equal(none.costPerAcceptedTask, null);
});

test("metrics: runtime acceptance of an incorrect result is a false acceptance; accepting an abstain-expected case is a safety failure", () => {
  const s = summarize([
    r({ independentlyCorrect: false, falseAcceptance: true }),
    r({ expect: "abstain", safetyFailure: true, independentlyCorrect: true }),
  ]);
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
      const out = spawnSync(process.execPath, ["--test"], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
      }).stdout;
      const m = new RegExp(GATE.discover.regex).exec(out);
      assert.ok(m && Number(m[1]) >= 1, `${c.id} (${overlay ? "fixed" : "initial"}): discovery found nothing`);
    }
  }
});

test("eval discovery accepts Node 22 TAP and Node 24 spec summaries, including zero tests", () => {
  for (const prefix of ["#", "ℹ"]) {
    for (const count of [0, 1, 12]) {
      const match = new RegExp(GATE.discover.regex).exec(`${prefix} tests ${count}\n`);
      assert.equal(Number(match?.[1]), count);
    }
  }
});

test("suite spending includes qualification and stops before another task can exceed remaining allowance", async () => {
  const { runSuite } = await import("../src/eval.ts");
  let calls = 0,
    reported = 0;
  const results: CaseResult[] = [];
  await assert.rejects(
    runSuite({
      onResult: (result) => results.push(result),
      evalsRoot: evals,
      suite: "dev-r1",
      trials: 1,
      budgetUsd: 0.0065,
      hosted: true,
      profile: { name: "fake", def: { kind: "claude-cli", model: "fake" } },
      provider: {
        id: "fake",
        hosted: true,
        supportsCostLimit: true,
        async generate(req) {
          calls++;
          const action = req.prompt.includes("File f.txt")
            ? {
                id: "p",
                kind: "edit",
                edits: [
                  {
                    kind: "replace",
                    path: "f.txt",
                    expectHash: req.prompt.match(/hash ([a-f0-9]+)/)![1],
                    find: "alpha",
                    replace: "beta",
                  },
                ],
              }
            : req.prompt.includes("Reply with the finish action")
              ? { id: "p", kind: "finish" }
              : { id: "p", kind: "blocked", reason: "fixture abstention" };
          return {
            content: JSON.stringify(action),
            finishReason: "stop",
            latencyMs: 1,
            usage: { input: 10, output: 5 },
            costUsd: Math.min(0.001, req.maxCostUsd!),
          };
        },
      },
      onSpend: (s) => {
        reported = s.costUsd;
      },
    }),
    /evaluation incomplete: spending stopped after 1\/8 cases/,
  );
  assert.equal(calls, 7); // six qualification calls, then one task
  assert.equal(results.length, 1);
  assert.ok(Math.abs(reported - 0.0065) < 1e-10);
  assert.ok(Math.abs(results[0]!.costUsd - reported) < 1e-10);
  assert.ok(results[0]!.qualificationCostUsd! > 0);
});

test("comparison refuses different trial pairs and incomplete billing has no cost per success", () => {
  assert.throws(() => compare([r({})], [r({ caseId: "different" })]), /same nonempty cases/);
  assert.equal(summarize([r({ unknownCostCalls: 1 })]).costPerAcceptedTask, null);
});

test("comparison rejects unknown, legacy, invalid or contradictory evidence", () => {
  for (const patch of [
    { unknownCostCalls: undefined },
    { unknownUsageCalls: 1 },
    { qualificationCostUsd: undefined },
    { costUsd: NaN },
    { tokens: -1 },
    { wallMs: Infinity },
    { qualificationCostUsd: 1 },
    { trial: 0 },
    { runtimeAccepted: true, independentlyCorrect: null },
    { falseAcceptance: true },
  ])
    assert.throws(() => compare([r({})], [r(patch)]));
  assert.throws(() => compare([r({})], [r({ family: "other" })]), /same nonempty cases/);
});

test("comparison CLI rejects partial reports and spend missing from result rows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "compare-evals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, "baseline.json"),
    b = join(dir, "candidate.json");
  const report = {
    results: [r({})],
    spend: { costUsd: 0.01, tokens: 1000, unknownCostCalls: 0, unknownUsageCalls: 0 },
  };
  writeFileSync(a, JSON.stringify(report));
  const cli = join(evals, "..", "packages/agent-runtime/scripts/compare-evals.ts");
  for (const [candidate, ok] of [
    [report, true],
    [{ ...report, failure: "interrupted after a billed call" }, false],
    [{ ...report, spend: { ...report.spend, costUsd: 0.02 } }, false],
    [{ ...report, spend: { ...report.spend, tokens: 2000 } }, false],
    [{ ...report, results: [r({ unknownCostCalls: undefined })] }, false],
    [{ results: null }, false],
  ] as const) {
    writeFileSync(b, JSON.stringify(candidate));
    const result = spawnSync(process.execPath, [cli, a, b], { encoding: "utf8" });
    assert.equal(result.status === 0, ok, result.stdout + result.stderr);
    if (ok) assert.match(result.stdout, /Observed deltas/);
    else assert.doesNotMatch(result.stdout, /Observed deltas/);
  }
});

test("evaluation refuses a hosted injected provider without egress consent before qualification", async () => {
  const { runSuite } = await import("../src/eval.ts");
  let calls = 0;
  await assert.rejects(
    runSuite({
      evalsRoot: evals,
      suite: "dev-r1",
      trials: 1,
      budgetUsd: 1,
      hosted: false,
      profile: { name: "fake", def: { kind: "claude-cli", model: "fake" } },
      provider: {
        id: "fake",
        hosted: true,
        async generate() {
          calls++;
          throw new Error("must not call");
        },
      },
    }),
    /explicit egress consent/,
  );
  assert.equal(calls, 0);
});
