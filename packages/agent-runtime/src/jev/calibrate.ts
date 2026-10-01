import { sha256 } from "../hash.ts";
import type { Calibration, Family } from "./fabric.ts";

// Per decision family: from labelled shadow records, find the lowest confidence whose records at-or-above it were
// right at least `target` of the time, with at least `minN` such records. Too little data → threshold null → the
// family can never act on Jev's choice. Confidence is a distribution statistic, so thresholds are never hardcoded.
export type Labelled = { confidence: number; jevChoice: string; truth: string };
export function calibrate(family: Family, rows: Labelled[], target = 0.95, minN = 30): Calibration & { bins: Array<{ lo: number; hi: number; n: number; accuracy: number | null }> } {
  const bins = Array.from({ length: 10 }, (_, i) => {
    const lo = i / 10, hi = (i + 1) / 10;
    const r = rows.filter((x) => x.confidence >= lo && (x.confidence < hi || (i === 9 && x.confidence <= 1)));
    return { lo, hi, n: r.length, accuracy: r.length ? r.filter((x) => x.jevChoice === x.truth).length / r.length : null };
  });
  // A threshold applies to every record at or above it, so candidates are the distinct confidence values and each
  // one is judged on all records >= it (never on a prefix that splits tied records).
  let threshold: number | null = null;
  for (const c of [...new Set(rows.map((r) => r.confidence))].sort((a, b) => b - a)) {
    const above = rows.filter((r) => r.confidence >= c);
    if (above.length >= minN && above.filter((r) => r.jevChoice === r.truth).length / above.length >= target) threshold = c;
  }
  const body = { family, threshold, n: rows.length, target, bins };
  return { id: sha256(JSON.stringify(body)).slice(0, 12), ...body };
}
