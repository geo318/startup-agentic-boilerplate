// Live evaluation run (spends money; hosted Claude). The approved cap must be passed explicitly:
//   MODEL=<id> PROFILE=<name> BUDGET_USD=<cap> TRIALS=<n> [SUITE=dev-r1] node scripts/run-eval.ts
// Writes evals/baselines/<suite>-<profile>-<utc>.json (results contain no source, keys, or prompts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSummary, runSuite, summarize } from "../src/eval.ts";

const model = process.env.MODEL,
  name = process.env.PROFILE,
  cap = Number(process.env.BUDGET_USD);
if (!model || !name || !(cap > 0)) throw new Error("set MODEL, PROFILE and BUDGET_USD (the approved spending cap)");
const suite = process.env.SUITE ?? "dev-r1";
const evalsRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "evals");
const results = await runSuite({
  evalsRoot,
  suite,
  trials: Number(process.env.TRIALS ?? 1),
  budgetUsd: cap,
  hosted: true,
  profile: { name, def: { kind: "claude-cli", model, maxBudgetUsd: Number(process.env.CALL_CAP_USD ?? 0.05) } },
  onResult: (r) =>
    console.log(
      `${r.caseId.padEnd(18)} ${r.state.padEnd(20)} correct=${String(r.independentlyCorrect).padEnd(5)} $${r.costUsd.toFixed(4)} ${r.tokens}tok ${(r.wallMs / 1000).toFixed(0)}s${r.refusal ? ` refused: ${r.refusal}` : ""}`,
    ),
}).catch((e) => {
  console.error(String(e));
  process.exit(1);
});
console.log(formatSummary(summarize(results)));
mkdirSync(join(evalsRoot, "baselines"), { recursive: true });
const file = join(evalsRoot, "baselines", `${suite}-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(
  file,
  JSON.stringify({ suite, model, profile: name, trials: Number(process.env.TRIALS ?? 1), results }, null, 2),
);
console.log(`saved ${file}`);
