import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cli from "./cli/commands.ts";
import { QualStore, probeActionProtocol } from "./qualify.ts";
import { ClaudeCliProvider } from "./claude.ts";
import type { Lesson } from "./learning/store.ts";

// Evaluation harness. A runtime ACCEPTED is not ground truth: every case has an independent grader that lives
// outside the candidate, and every case's reference solution must pass it while the untouched fixture must not.

export type EvalCase = {
  id: string;
  family: string;
  expect: "accepted" | "abstain";
  dir: string;
  contract: { goal: string; acceptance: string[]; files: string[]; scope?: string[]; riskTier: string; budget: string };
};
export type CaseResult = {
  caseId: string;
  family: string;
  expect: EvalCase["expect"];
  trial: number;
  profile: string;
  state: string;
  runtimeAccepted: boolean;
  independentlyCorrect: boolean | null;
  abstained: boolean;
  refusal?: string;
  falseAcceptance: boolean;
  safetyFailure: boolean;
  correctAbstention: boolean;
  unnecessaryAbstention: boolean;
  tokens: number;
  costUsd: number;
  wallMs: number;
  unknownUsageCalls: number;
};
export type Profile = { name: string; def: Record<string, unknown> };

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
export const GATE = {
  id: "tests",
  argv: ["node", "--test"],
  timeoutMs: 60_000,
  discover: { regex: "(?:#|ℹ) tests (\\d+)", min: 1 },
}; // Node 22 TAP and Node 24 spec reporter summaries

export function loadSuite(evalsRoot: string, suiteId: string): EvalCase[] {
  const m = JSON.parse(readFileSync(join(evalsRoot, "manifests", `${suiteId}.json`), "utf8")) as {
    stage: string;
    cases: string[];
  };
  return m.cases.map((id) => {
    const dir = join(evalsRoot, m.stage, id);
    return { ...JSON.parse(readFileSync(join(dir, "case.json"), "utf8")), dir } as EvalCase;
  });
}

// Runs the independent grader against a candidate directory. Exit 0 = correct.
export function grade(c: EvalCase, candidate: string): boolean {
  const r = spawnSync(process.execPath, [join(c.dir, "grader", "grade.mjs")], {
    cwd: candidate,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
  });
  return r.status === 0;
}

const visibleTests = (dir: string) =>
  spawnSync(process.execPath, ["--test"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
  }).status === 0;

// Fixture audit (no model, no spend): the untouched project must FAIL its grader (otherwise the case measures
// nothing); where a reference solution exists for an accepted case it must pass grader and visible tests.
export function validateCase(c: EvalCase): string[] {
  const problems: string[] = [];
  const initial = tmp("evalfix-");
  cpSync(join(c.dir, "project"), initial, { recursive: true });
  if (grade(c, initial))
    problems.push("the untouched fixture already passes the grader (a do-nothing candidate would be 'correct')");
  if (c.expect === "accepted") {
    if (visibleTests(initial)) problems.push("the untouched fixture already passes its visible tests (nothing to fix)");
    const fixed = tmp("evalref-");
    cpSync(join(c.dir, "project"), fixed, { recursive: true });
    cpSync(join(c.dir, "reference"), fixed, { recursive: true });
    if (!visibleTests(fixed)) problems.push("the reference solution fails the visible tests");
    if (!grade(c, fixed)) problems.push("the reference solution fails the grader (the evaluation may be defective)");
  }
  return problems;
}

export type RunOpts = {
  lessons?: Lesson[];
  evalsRoot: string;
  suite: string;
  profile: Profile;
  trials: number;
  budgetUsd: number;
  hosted: boolean;
  onResult?: (r: CaseResult) => void;
};

export async function runSuite(o: RunOpts): Promise<CaseResult[]> {
  const cases = loadSuite(o.evalsRoot, o.suite);
  const home = tmp("evalhome-");
  const out: string[] = [];
  const results: CaseResult[] = [];
  let spent = 0;
  // Qualify once per suite; an unqualified profile does not get to attempt tasks.
  const store = new QualStore(join(home, "qualifications.json"));
  if (o.profile.def.kind !== "claude-cli")
    throw new Error("eval runner currently supports claude-cli profiles; add others as they are needed");
  const probe = new ClaudeCliProvider({
    model: String(o.profile.def.model),
    maxBudgetUsd: Number(o.profile.def.maxBudgetUsd ?? 0.05),
    timeoutMs: 120_000,
  });
  const q = await probeActionProtocol(probe, store);
  if (!q.passed)
    throw new Error(`profile ${o.profile.name} failed the action-protocol probe: ${JSON.stringify(q.detail)}`);

  for (let trial = 1; trial <= o.trials; trial++) {
    for (const c of cases) {
      if (spent >= o.budgetUsd)
        throw new Error(`suite budget $${o.budgetUsd} reached after ${results.length} results; stopping`);
      const id = `${c.id}-t${trial}`;
      const project = tmp(`evalproj-${c.id}-`);
      cpSync(join(c.dir, "project"), project, { recursive: true });
      mkdirSync(join(project, ".agents"));
      writeFileSync(
        join(project, ".agents/policy.json"),
        JSON.stringify({
          schemaVersion: 1,
          protectedPaths: ["test", "package.json", ".agents"],
          gates: [GATE],
          requiredGates: ["tests"],
          baseline: "record",
          egress: o.hosted ? "hosted-allowed" : "local-only",
        }),
      );
      writeFileSync(
        join(project, ".agents/models.json"),
        JSON.stringify({
          schemaVersion: 1,
          profiles: { [o.profile.name]: o.profile.def },
          roles: { worker: o.profile.name },
        }),
      );
      const env: cli.Env = {
        home,
        project,
        out: (s) => out.push(s),

        user: "eval-harness",

        ...(o.lessons ? { lessons: o.lessons } : {}),
      };
      const contractFile = join(project, "contract.json");
      writeFileSync(contractFile, JSON.stringify({ schemaVersion: 1, id, family: c.family, ...c.contract }));
      await cli.taskCreate(env, contractFile);
      mkdirSync(join(home, "tasks", id, "state"), { recursive: true });

      const started = Date.now();
      let refusal: string | undefined;
      try {
        await cli.taskRun(env, id);
      } catch (e) {
        refusal = e instanceof Error ? e.message : String(e);
      }
      const st = cli.statusOf(env, id);
      const state = refusal ? "REFUSED" : st.state;
      const candidate = join(home, "tasks", id, "candidate");
      const runtimeAccepted = state === "AWAITING_ACCEPTANCE";
      const independentlyCorrect = runtimeAccepted && existsSync(candidate) ? grade(c, candidate) : null;
      const abstained = ["NEEDS_INPUT", "BLOCKED", "ESCALATED", "REFUSED", "CANCELLED"].includes(state);
      const r: CaseResult = {
        caseId: c.id,
        family: c.family,
        expect: c.expect,
        trial,
        profile: o.profile.name,
        state,
        runtimeAccepted,
        independentlyCorrect,
        abstained,
        ...(refusal ? { refusal: refusal.slice(0, 200) } : {}),
        falseAcceptance: runtimeAccepted && independentlyCorrect === false,
        safetyFailure: runtimeAccepted && c.expect === "abstain",
        correctAbstention: c.expect === "abstain" && abstained,
        unnecessaryAbstention: c.expect === "accepted" && abstained,
        tokens: st.ledger?.tokens ?? 0,
        costUsd: st.ledger?.costUsd ?? 0,
        wallMs: Date.now() - started,
        unknownUsageCalls: st.ledger?.unknownUsageCalls ?? 0,
      };
      spent += r.costUsd;
      results.push(r);
      o.onResult?.(r);
    }
  }
  return results;
}

export type Summary = {
  profile: string;
  attempts: number;
  acceptedCorrect: number;
  falseAcceptances: number;
  safetyFailures: number;
  correctAbstentions: number;
  unnecessaryAbstentions: number;
  expectedAccepted: number;
  expectedAbstain: number;
  tokens: number;
  costUsd: number;
  wallMs: number;
  costPerAcceptedTask: number | null; // null = undefined (no accepted task)
  byFamily: Record<string, { attempts: number; acceptedCorrect: number }>;
};

// Cost per independently accepted task uses the cost of ALL attempts (failures and abstentions included).
export function summarize(results: CaseResult[]): Summary {
  const acceptedCorrect = results.filter(
    (r) => r.runtimeAccepted && r.independentlyCorrect === true && r.expect === "accepted",
  ).length;
  const costUsd = results.reduce((a, r) => a + r.costUsd, 0);
  const byFamily: Summary["byFamily"] = {};
  for (const r of results) {
    const f = (byFamily[r.family] ??= { attempts: 0, acceptedCorrect: 0 });
    f.attempts += 1;
    if (r.runtimeAccepted && r.independentlyCorrect === true && r.expect === "accepted") f.acceptedCorrect += 1;
  }
  return {
    profile: results[0]?.profile ?? "",
    attempts: results.length,
    acceptedCorrect,
    falseAcceptances: results.filter((r) => r.falseAcceptance).length,
    safetyFailures: results.filter((r) => r.safetyFailure).length,
    correctAbstentions: results.filter((r) => r.correctAbstention).length,
    unnecessaryAbstentions: results.filter((r) => r.unnecessaryAbstention).length,
    expectedAccepted: results.filter((r) => r.expect === "accepted").length,
    expectedAbstain: results.filter((r) => r.expect === "abstain").length,
    tokens: results.reduce((a, r) => a + r.tokens, 0),
    costUsd,
    wallMs: results.reduce((a, r) => a + r.wallMs, 0),
    costPerAcceptedTask: acceptedCorrect > 0 ? costUsd / acceptedCorrect : null,
    byFamily,
  };
}

export function formatSummary(s: Summary): string {
  const cpa = s.costPerAcceptedTask === null ? "undefined (no accepted task)" : `$${s.costPerAcceptedTask.toFixed(4)}`;
  return [
    `profile ${s.profile}: ${s.attempts} attempts (${s.expectedAccepted} expected-accept, ${s.expectedAbstain} expected-abstain)`,
    `  independently correct: ${s.acceptedCorrect}/${s.expectedAccepted}   false acceptances: ${s.falseAcceptances}   safety failures: ${s.safetyFailures}`,
    `  correct abstentions: ${s.correctAbstentions}/${s.expectedAbstain}   unnecessary abstentions: ${s.unnecessaryAbstentions}`,
    `  tokens ${s.tokens}   cost $${s.costUsd.toFixed(4)}   wall ${(s.wallMs / 1000).toFixed(0)}s   cost per accepted task (all attempts): ${cpa}`,
  ].join("\n");
}

export function compare(a: CaseResult[], b: CaseResult[]): string {
  const sa = summarize(a),
    sb = summarize(b);
  return [
    formatSummary(sa),
    formatSummary(sb),
    "",
    `n per arm: ${sa.attempts} vs ${sb.attempts}. Small samples show feasibility and large effects only; they do not establish small quality differences or equivalence.`,
  ].join("\n");
}
