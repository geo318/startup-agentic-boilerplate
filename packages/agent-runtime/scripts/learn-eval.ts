// Live evaluation of a candidate lesson (spends money; hosted Claude). The approved cap must be given explicitly:
//   MODEL=<id> PROFILE=<name> BUDGET_USD=<cap> LESSON_TEXT="..." LESSON_TOPIC=<slug> node scripts/learn-eval.ts
// Uses a temporary learning home: nothing here touches ~/.agentic or any active lesson set.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseResult } from "../src/eval.ts";
import { runSuite } from "../src/eval.ts";
import * as L from "../src/learning/store.ts";

const { MODEL, PROFILE, LESSON_TEXT, LESSON_TOPIC } = process.env;
const cap = Number(process.env.BUDGET_USD);
if (!MODEL || !PROFILE || !LESSON_TEXT || !LESSON_TOPIC || !(cap > 0))
  throw new Error("set MODEL, PROFILE, LESSON_TEXT, LESSON_TOPIC, BUDGET_USD");
const evalsRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "evals");
const home = mkdtempSync(join(tmpdir(), "learneval-"));

// A verified incident from a real earlier eval run if one is still on disk, else a synthetic controller log.
let incidentId: string | undefined;
for (const root of [tmpdir()]) {
  for (const d of existsSync(root) ? readdirSync(root).filter((x) => x.startsWith("evalhome-")) : []) {
    const task = join(root, d, "tasks", "parse-duration-t1");
    if (!existsSync(join(task, "state", "events.jsonl"))) continue;
    mkdirSync(join(home, "tasks"), { recursive: true });
    try {
      // copy the log into our learning home so captureIncident reads controller facts only
      const { cpSync } = await import("node:fs");
      cpSync(task, join(home, "tasks", "parse-duration-t1"), {
        recursive: true,
      });
      incidentId = L.captureIncident(home, "parse-duration-t1")?.id;
      if (incidentId) break;
    } catch {
      /* try the next one */
    }
  }
  if (incidentId) break;
}
if (!incidentId) throw new Error("no real incident log found on disk; run the eval first");

const proposal = L.propose(
  home,
  {
    kind: "lesson",
    incidentIds: [incidentId],
    families: [],
    supersedes: undefined as never,
    cause: "a real run exhausted its token budget before verification (observed in an earlier eval)",
    lesson: { id: "les-candidate", topic: LESSON_TOPIC, text: LESSON_TEXT },
    counterexample: "tasks that need several edits before finishing",
    expectedBenefit: "fewer wasted tokens per task",
    evaluationPlan: "dev-r1 + holdout-r1, baseline vs candidate, same profile and budgets",
    limitations: "one incident; one model; small suite",
  },
  { holdoutDir: join(evalsRoot, "holdout") },
);
console.log(`proposal ${proposal.id} quarantined: "${LESSON_TEXT}"`);

let spent = 0;
const allRuns: Array<{
  lessons: number;
  caseId: string;
  state: string;
  correct: boolean | null;
  costUsd: number;
}> = [];
const runner: L.Runner = async (lessons) => {
  const out: CaseResult[] = [];
  for (const suite of ["dev-r1", "holdout-r1"]) {
    const part = await runSuite({
      evalsRoot,
      suite,
      trials: 1,
      budgetUsd: Math.max(cap - spent, 0.001),
      hosted: true,
      lessons,
      profile: {
        name: PROFILE!,
        def: { kind: "claude-cli", model: MODEL!, maxBudgetUsd: 0.05 },
      },
    });
    spent += part.reduce((a, r) => a + r.costUsd, 0);
    out.push(...part.map((r) => ({ ...r, caseId: `${suite}/${r.caseId}` })));
    console.log(
      `  ${lessons.length ? "candidate" : "baseline "} ${suite}: ${part.filter((r) => r.runtimeAccepted && r.independentlyCorrect).length}/${part.filter((r) => r.expect === "accepted").length} correct, spent so far $${spent.toFixed(3)}`,
    );
  }
  allRuns.push(
    ...out.map((r) => ({
      lessons: lessons.length,
      caseId: r.caseId,
      state: r.state,
      correct: r.independentlyCorrect,
      costUsd: r.costUsd,
    })),
  );
  return out;
};
const ev = await L.evaluate(home, proposal.id, runner, PROFILE!);
console.log(
  `\nverdict: ${ev.verdict.toUpperCase()}  n=${ev.n}  regressions: ${ev.regressions.join(", ") || "none"}  improved: ${ev.improved.join(", ") || "none"}`,
);
console.log(
  `baseline : correct ${ev.baseline.acceptedCorrect}/${ev.baseline.expectedAccepted}  false-acc ${ev.baseline.falseAcceptances}  safety ${ev.baseline.safetyFailures}  cost $${ev.baseline.costUsd.toFixed(3)}`,
);
console.log(
  `candidate: correct ${ev.candidate.acceptedCorrect}/${ev.candidate.expectedAccepted}  false-acc ${ev.candidate.falseAcceptances}  safety ${ev.candidate.safetyFailures}  cost $${ev.candidate.costUsd.toFixed(3)}`,
);
console.log(
  `reasons: ${ev.reasons.join("; ") || "none"}\nproposal state now: ${L.getProposal(home, proposal.id).state}; active lessons: ${L.activeLessons(home, {}).lessons.length}; total spend $${spent.toFixed(3)}`,
);
const file = join(
  evalsRoot,
  "baselines",
  `learn-${LESSON_TOPIC}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
writeFileSync(
  file,
  JSON.stringify(
    {
      lesson: { topic: LESSON_TOPIC, text: LESSON_TEXT },
      profile: PROFILE,
      model: MODEL,
      evaluation: ev,
      runsPerEvaluation: 3,
      perCase: allRuns,
    },
    null,
    2,
  ),
);
console.log(`saved ${file}`);
