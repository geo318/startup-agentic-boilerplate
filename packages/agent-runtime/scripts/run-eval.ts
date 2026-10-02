// Live evaluation run (spends money; hosted Claude). The approved cap must be passed explicitly:
//   MODEL=<id> PROFILE=<name> BUDGET_USD=<cap> TRIALS=<n> [SUITE=dev-r1] node scripts/run-eval.ts
// Writes evals/baselines/<suite>-<profile>-<utc>.json (results contain no source, keys, or prompts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSummary, runSuite, summarize, type CaseResult } from "../src/eval.ts";

const model = process.env.MODEL,
  name = process.env.PROFILE,
  cap = Number(process.env.BUDGET_USD);
if (!model || !name || !(cap > 0)) throw new Error("set MODEL, PROFILE and BUDGET_USD (the approved spending cap)");
const suite = process.env.SUITE ?? "dev-r1";
const evalsRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "evals");
const results: CaseResult[] = [];
let spend: unknown;
let failure: string | undefined;
mkdirSync(join(evalsRoot, "baselines"), { recursive: true });
const file = join(evalsRoot, "baselines", `${suite}-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const save = () =>
  writeFileSync(
    file,
    JSON.stringify(
      {
        suite,
        model,
        profile: name,
        trials: Number(process.env.TRIALS ?? 1),
        results,
        spend,
        ...(failure ? { failure } : {}),
      },
      null,
      2,
    ),
  );
await runSuite({
  evalsRoot,
  suite,
  trials: Number(process.env.TRIALS ?? 1),
  budgetUsd: cap,
  hosted: true,
  profile: { name, def: { kind: "claude-cli", model, maxBudgetUsd: Number(process.env.CALL_CAP_USD ?? 0.05) } },
  onSpend: (s) => {
    spend = s;
    save();
  },
  onResult: (r) => {
    results.push(r);
    save();
    console.log(`${r.caseId} ${r.state} correct=${r.independentlyCorrect} $${r.costUsd.toFixed(4)} ${r.tokens}tok`);
  },
}).catch((e) => {
  failure = String(e);
  console.error(failure);
  process.exitCode = 1;
});
save();
console.log(formatSummary(summarize(results)));
console.log(`saved ${file} (includes qualification accounting; partial results survive errors)`);
