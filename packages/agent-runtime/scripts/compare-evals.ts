// Compare independently graded, paired trials. No model calls.
import { readFileSync } from "node:fs";
import { compare, type CaseResult } from "../src/eval.ts";
const [baseline, candidate] = process.argv.slice(2);
if (!baseline || !candidate) throw new Error("usage: node scripts/compare-evals.ts baseline.json candidate.json");
const read = (f: string): CaseResult[] => {
  const d = JSON.parse(readFileSync(f, "utf8"));
  if (d.failure) throw new Error(`${f}: incomplete evaluation: ${d.failure}`);
  // Reuse row validation before reconciling the separately persisted experiment account.
  compare(d.results, d.results);
  if (d.spend) {
    const cost = d.results.reduce((n: number, r: CaseResult) => n + r.costUsd, 0);
    const tokens = d.results.reduce((n: number, r: CaseResult) => n + r.tokens, 0);
    if (
      d.spend.unknownCostCalls !== 0 ||
      d.spend.unknownUsageCalls !== 0 ||
      !Number.isFinite(d.spend.costUsd) ||
      Math.abs(d.spend.costUsd - cost) > 1e-9 * Math.max(1, cost) ||
      d.spend.tokens !== tokens
    )
      throw new Error(`${f}: incomplete accounting; spend does not reconcile with results`);
  }
  return d.results;
};
console.log(compare(read(baseline), read(candidate)));
