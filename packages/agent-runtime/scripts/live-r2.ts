// Live R2 pilot (spends money; hosted Claude). Two phases so a human approves the exact plan:
//   DIR=<dir> MODEL=<id> node scripts/live-r2.ts plan                      → architect writes <dir>/plan.json, prints it
//   DIR=<dir> MODEL=<id> APPROVED_PLAN_HASH=<hash> node scripts/live-r2.ts run
// The reviewer qualification below is OWNER-DECLARED for this pilot, not measured.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../src/budget.ts";
import { ClaudeCliProvider } from "../src/claude.ts";
import { drive } from "../src/drive.ts";
import { sha256 } from "../src/hash.ts";
import { architect, review } from "../src/roles.ts";
import { Run } from "../src/run.ts";

const phase = process.argv[2];
const dir = process.env.DIR ?? "";
const model = process.env.MODEL ?? "";
if (!dir || !model || !["plan", "run"].includes(phase ?? ""))
  throw new Error("usage: DIR= MODEL= [APPROVED_PLAN_HASH=] node scripts/live-r2.ts plan|run");
const ws = join(dir, "ws");
const provider = new ClaudeCliProvider({
  model,
  maxBudgetUsd: 0.05,
  timeoutMs: 120_000,
});
const task = {
  goal: "greeting() must return the string hello (it has a typo)",
  acceptance: ["check.mjs exits 0"],
  files: ["greeting.mjs"],
};
const ledger = new Ledger({
  aggregateTokens: 40_000,
  toolActions: 8,
  semanticRepairs: 1,
});

if (phase === "plan") {
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "greeting.mjs"), `export const greeting = () => "helo";\n`);
  writeFileSync(
    join(ws, "check.mjs"),
    `import {greeting} from "./greeting.mjs"; console.log("tests 1"); process.exit(greeting()==="hello"?0:1)\n`,
  );
  const plan = await architect(
    { provider, ledger, egress: "hosted-allowed" },
    {
      goal: task.goal,
      acceptance: task.acceptance,
      context: readFileSync(join(ws, "greeting.mjs"), "utf8"),
    },
  );
  const text = JSON.stringify(plan, null, 2);
  writeFileSync(join(dir, "plan.json"), text);
  console.log(text);
  console.log(`\nPLAN_HASH=${sha256(text)}  tokens=${ledger.tokens} costUsd=${ledger.costUsd}`);
} else {
  const text = readFileSync(join(dir, "plan.json"), "utf8");
  if (process.env.APPROVED_PLAN_HASH !== sha256(text))
    throw new Error("plan not approved: APPROVED_PLAN_HASH does not match plan.json");
  const run = new Run(
    {
      workspace: ws,
      stateDir: join(dir, "state"),
      protectedPaths: ["check.mjs"],
      riskTier: "R2",
      egress: "hosted-allowed",
      isolation: "none",
      gates: [
        {
          id: "unit",
          argv: ["node", "check.mjs"],
          timeoutMs: 10_000,
          discover: { regex: "tests (\\d+)", min: 1 },
        },
      ],
      requiredGates: ["unit"],
      limits: { aggregateTokens: 40_000, toolActions: 8, semanticRepairs: 1 },
    },
    { ledger },
  );
  run.start();
  run.approvePlan("operator (hash-confirmed)", text);
  const t = Date.now();
  await drive(run, provider, ws, { ...task, plan: text }, 6, 1500, 3000);
  let findings: unknown = null;
  if (run.state === "REVIEWING") {
    const f = await review(
      { provider, ledger, egress: "hosted-allowed" },
      {
        goal: task.goal,
        acceptance: task.acceptance,
        changed: run.changed(),
        gates: run.evidence?.gates ?? [{ gateId: "unit", status: "pass" }],
      },
    );
    findings = f;
    run.completeReview(f);
  }
  console.log(
    JSON.stringify(
      {
        state: run.state,
        tier: run.evidence?.tier,
        planHash: run.evidence?.planHash?.slice(0, 12),
        findings,
        tokens: ledger.tokens,
        costUsd: ledger.costUsd,
        unknownUsageCalls: ledger.unknownUsageCalls,
        wallMs: Date.now() - t,
      },
      null,
      2,
    ),
  );
  run.close();
}
