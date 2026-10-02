import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GateResult, type GateSpec, runGate } from "./gates.ts";
import { canonical, sha256 } from "./hash.ts";
import { riskFloor, type RiskTier } from "./risk.ts";
import { snapshot } from "./run.ts";

// Automatic after-the-fact check, called from the project's Stop hook: run the policy's required gates on whatever
// the working tree now contains and record one row. The controller did not drive any model here, so this is
// verification evidence only (no cost, no worker routing). Reuse is explicit because external state can change.
export type SessionRow = {
  ts: string;
  project: string;
  branch: string;
  digest: string;
  checkKey?: string;
  changed: number;
  tier: RiskTier;
  passed: boolean;
  gates: Array<{ id: string; status: string; discovered: number | null; ms: number }>;
  tail?: string; // failing gate's last output lines, so an unchanged re-check can repeat the diagnostic
};

const file = (home: string) => join(home, "sessions.jsonl");
export function readSessions(home: string, strict = false): SessionRow[] {
  return existsSync(file(home))
    ? readFileSync(file(home), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l, i) => {
          try {
            const row = JSON.parse(l) as SessionRow;
            if (
              !row ||
              typeof row.project !== "string" ||
              !Number.isFinite(Date.parse(row.ts)) ||
              typeof row.passed !== "boolean"
            )
              throw new Error("invalid session row");
            return [row];
          } catch {
            if (strict)
              throw new Error(`Cannot report complete stats: unreadable session record at ${file(home)} line ${i + 1}`);
            return []; // best-effort consumers can ignore a torn last line
          }
        })
    : [];
}

const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });
export const currentBranch = (cwd: string) => git(cwd, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim() || "unknown";

export async function sessionCheck(o: {
  home: string;
  project: string;
  gates: GateSpec[];
  requiredGates: string[];
  protectedPaths?: string[];
  out: (s: string) => void;
  reuse?: boolean; // explicit: dependency/environment state cannot be inferred from source hashes
}): Promise<number> {
  const paths = git(o.project, "status", "--porcelain", "--untracked-files=all")
    .stdout.split("\n")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).split(" -> ").pop()!);
  // An agent may commit before handoff; a clean worktree still needs its branch changes checked.
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const changed = git(o.project, "diff", "--name-only", `${ref}...HEAD`);
    if (changed.status === 0) {
      paths.push(...changed.stdout.split("\n").filter(Boolean));
      break;
    }
  }
  if (paths.length === 0 || paths.every((p) => /\.mdx?$/.test(p))) return 0; // nothing to test
  const digest = snapshot(o.project);
  const source = snapshot(o.project, undefined, true);
  const protectedDigest = snapshot(o.project, o.protectedPaths ?? []);
  const checkKey = sha256(
    canonical({
      gates: o.gates,
      required: o.requiredGates,
      protectedPaths: o.protectedPaths ?? [],
      node: process.version,
      platform: process.platform,
      path: process.env.PATH ?? "",
    }),
  );
  const prior = o.reuse
    ? readSessions(o.home)
        .reverse()
        .find(
          (r) =>
            r.project === o.project &&
            r.branch === currentBranch(o.project) &&
            r.digest === digest &&
            r.checkKey === checkKey &&
            r.passed,
        )
    : undefined;
  if (prior) {
    if (!prior.passed && prior.tail) o.out(prior.tail);
    return prior.passed ? 0 : 2;
  }
  const results: GateResult[] = [];
  for (const id of o.requiredGates) {
    const spec = o.gates.find((g) => g.id === id);
    if (!spec) throw new Error(`required gate not defined: ${id}`);
    let r = await runGate(spec, o.project, digest);
    if (
      r.status === "pass" &&
      (snapshot(o.project, undefined, true) !== source ||
        snapshot(o.project, o.protectedPaths ?? []) !== protectedDigest)
    )
      r = { ...r, status: "fail", note: "gate modified the working tree; its result does not describe these bytes" };
    results.push(r);
    if (r.status !== "pass") break;
  }
  const bad = results.find((r) => r.status !== "pass");
  const tail = bad
    ? [`gate ${bad.gateId}: ${bad.status}`, bad.note, ...bad.outputTail.split("\n").filter(Boolean).slice(-15)]
        .filter(Boolean)
        .join("\n")
    : undefined;
  const row: SessionRow = {
    ts: new Date().toISOString(),
    project: o.project,
    branch: currentBranch(o.project),
    digest: bad ? digest : snapshot(o.project),
    checkKey,
    changed: new Set(paths).size,
    tier: riskFloor({ paths }),
    passed: !bad && results.length === o.requiredGates.length,
    gates: results.map((r) => ({ id: r.gateId, status: r.status, discovered: r.discovered, ms: r.durationMs })),
    ...(tail ? { tail } : {}),
  };
  mkdirSync(o.home, { recursive: true });
  appendFileSync(file(o.home), `${JSON.stringify(row)}\n`);
  if (tail) o.out(tail);
  return row.passed ? 0 : 2;
}

export const SUMMARY_START = "<!-- agentic-summary -->";
export const SUMMARY_END = "<!-- /agentic-summary -->";

// Markdown block for a PR body, from the sessions recorded on this branch. Counts only; it claims nothing about savings.
export function prSummary(home: string, project: string): string {
  const branch = currentBranch(project);
  const rows = readSessions(home).filter((r) => r.project === project && r.branch === branch);
  const last = rows.at(-1);
  const tiers = ["R0", "R1", "R2", "R3"] as const;
  const top = rows.reduce<RiskTier | null>(
    (a, r) => (a === null || tiers.indexOf(r.tier) > tiers.indexOf(a) ? r.tier : a),
    null,
  );
  const body = rows.length
    ? [
        `- Automatic gate checks on this branch: ${rows.length} (${rows.filter((r) => r.passed).length} passed, ${rows.filter((r) => !r.passed).length} failed)`,
        `- Latest: ${last!.passed ? "passed" : "FAILED"} at ${last!.ts} (${last!.changed} changed file(s), gates ${last!.gates.map((g) => `${g.id} ${g.status}${g.discovered === null ? "" : ` (${g.discovered} tests)`}`).join(", ")})`,
        `- Highest risk tier seen: ${top}`,
        "- These are controller-run results on the working tree, recorded locally; they do not replace the required CI check.",
      ]
    : ["- No automatic gate checks were recorded on this branch."];
  return [SUMMARY_START, "### Agentic checks", ...body, SUMMARY_END].join("\n");
}

// Best-effort: put/replace the block in the open PR's body for this branch. Never fails a push.
export function updatePr(home: string, project: string): string {
  const view = spawnSync("gh", ["pr", "view", "--json", "body,number"], { cwd: project, encoding: "utf8" });
  if (view.status !== 0) return "no open PR for this branch (or gh unavailable): nothing updated";
  const { body, number } = JSON.parse(view.stdout) as { body: string; number: number };
  const block = prSummary(home, project);
  const re = new RegExp(`${SUMMARY_START}[\\s\\S]*?${SUMMARY_END}`);
  const next = re.test(body) ? body.replace(re, block) : `${body}\n\n${block}\n`;
  if (next === body) return `PR #${number} summary already current`;
  const tmp = join(home, `pr-body-${number}.md`);
  mkdirSync(home, { recursive: true });
  writeFileSync(tmp, next);
  const edit = spawnSync("gh", ["pr", "edit", String(number), "--body-file", tmp], { cwd: project, encoding: "utf8" });
  return edit.status === 0 ? `PR #${number} summary updated` : `could not update PR #${number}`;
}
