import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../hash.ts";
import { EventLog } from "../events.ts";
import type { CaseResult } from "../eval.ts";
import { summarize, type Summary } from "../eval.ts";

// Controlled learning. Lessons only ever reach a worker through an ACTIVE release created by a human-only
// promotion after an evaluation passed. Everything before that sits in quarantine, outside any worker's reach.
export type Lesson = { id: string; topic: string; text: string; families?: string[]; expiresAt?: string };
export type Incident = {
  id: string; taskId: string; outcome: { state: string; why?: string }; facts: string[]; eventSeqs: number[]; createdAt: string;
};
export type Evaluation = {
  profile: string; ranAt: string; lessonHash: string; n: number; baseline: Summary; candidate: Summary;
  regressions: string[]; improved: string[]; unstable: string[]; verdict: "pass" | "fail"; reasons: string[];
};
export type Proposal = {
  id: string; kind: "lesson"; incidentIds: string[]; cause: string; families: string[]; lesson: Lesson;
  counterexample: string; expectedBenefit: string; evaluationPlan: string; limitations: string;
  supersedes?: string; state: "quarantined" | "evaluated" | "promoted" | "rejected" | "retired"; evaluation?: Evaluation;
  promotion?: { approver: string; at: string; releaseId: string }; createdAt: string;
};
export type Release = { id: string; version: number; lessons: Lesson[]; approver: string; at: string; proposalId: string | null; rollbackTarget: string | null; hash: string; note?: string };

const dirs = (home: string) => ({ inc: join(home, "learning", "incidents"), prop: join(home, "learning", "proposals"), rel: join(home, "learning", "releases"), active: join(home, "learning", "ACTIVE") });
const j = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const put = (dir: string, id: string, v: unknown) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${id}.json`), JSON.stringify(v, null, 2)); };
const all = <T>(dir: string): T[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => j(join(dir, f)) as T) : []);

export class LearningError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

// ---- incidents: controller facts only, no model call, no raw output, no private reasoning ----
export function captureIncident(home: string, taskId: string): Incident | null {
  const evFile = join(home, "tasks", taskId, "state", "events.jsonl");
  if (!existsSync(evFile)) throw new LearningError("unknown task", `no event log for task ${taskId}`);
  const events = new EventLog(evFile).read();
  const last = [...events].reverse().find((e) => e.type === "state");
  const state = (last?.data as any)?.to as string;
  const facts: string[] = [], seqs: number[] = [];
  const rejected = events.filter((e) => e.type === "rejected");
  const byReason = new Map<string, number>();
  for (const e of rejected) byReason.set((e.data as any).reason, (byReason.get((e.data as any).reason) ?? 0) + 1);
  for (const [reason, n] of byReason) if (n >= 2) facts.push(`${n} actions were rejected with reason "${reason}"`);
  rejected.forEach((e) => seqs.push(e.seq));
  const gates = events.filter((e) => e.type === "gate");
  for (const g of gates) { const d = g.data as any; if (d.status !== "pass") { facts.push(`gate ${d.gateId} ended ${d.status}${d.note ? ` (${d.note})` : ""}`); seqs.push(g.seq); } }
  const why = (last?.data as any)?.why as string | undefined;
  if (["BLOCKED", "ESCALATED", "NEEDS_INPUT"].includes(state) && why) { facts.push(`run ended ${state}: ${why}`); if (last) seqs.push(last.seq); }
  if (facts.length === 0) return null; // nothing verified happened worth learning from
  const inc: Incident = { id: `inc-${sha256(taskId + facts.join("|")).slice(0, 10)}`, taskId, outcome: { state, ...(why ? { why } : {}) }, facts, eventSeqs: [...new Set(seqs)].sort((a, b) => a - b), createdAt: new Date().toISOString() };
  put(dirs(home).inc, inc.id, inc);
  return inc;
}
export const getIncident = (home: string, id: string) => { const f = join(dirs(home).inc, `${id}.json`); return existsSync(f) ? (j(f) as Incident) : undefined; };

// ---- lesson validation ----
// A deny-list is NOT a security boundary: evaluation and human promotion are. It only rejects what must never be a lesson:
// anything touching safety policy, egress, budgets, graders, approvals or runtime authority (those need protected maintenance review).
const PROTECTED_TOPICS = /\b(skip|bypass|disable|ignore|override|approve|accept(?:ance)?|egress|budget|grader|policy|secret|credential|api[_ -]?key|token|sudo|rm -rf|--force|no-verify|protected|baseline|threshold|authori[sz]|permission)\b/i;
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export function holdoutMaterial(holdoutDir: string): string[] {
  if (!existsSync(holdoutDir)) return [];
  const lines: string[] = [];
  const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/(reference|grader)/.test(p)) lines.push(...readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length >= 20));
  });
  walk(holdoutDir);
  return lines;
}
export function validateLesson(l: Lesson, o: { holdoutDir?: string } = {}): string[] {
  const p: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(l.topic)) p.push("topic must be a short slug");
  if (l.text.length < 15 || l.text.length > 300) p.push("lesson text must be 15-300 characters");
  if (/```|\$\(|&&|\|\|/.test(l.text)) p.push("lessons are plain guidance, not code or shell");
  if (PROTECTED_TOPICS.test(l.text)) p.push("touches safety policy, egress, budgets, approvals or graders: needs a protected maintenance change, not a lesson");
  if (o.holdoutDir) {
    const t = l.text.toLowerCase();
    if (holdoutMaterial(o.holdoutDir).some((line) => t.includes(line.toLowerCase()))) p.push("contains holdout material");
  }
  return p;
}

// ---- proposals (quarantine) ----
export function propose(home: string, input: Omit<Proposal, "id" | "state" | "createdAt">, o: { holdoutDir?: string } = {}): Proposal {
  if (input.incidentIds.length === 0) throw new LearningError("unevidenced", "a proposal needs at least one verified incident");
  for (const id of input.incidentIds) {
    const inc = getIncident(home, id);
    if (!inc || inc.facts.length === 0) throw new LearningError("unevidenced", `incident ${id} does not exist or has no verified facts`);
  }
  for (const f of ["cause", "counterexample", "expectedBenefit", "evaluationPlan", "limitations"] as const) if (!input[f]?.trim()) throw new LearningError("incomplete", `proposal.${f} is required`);
  const problems = validateLesson(input.lesson, o);
  if (problems.length) throw new LearningError("invalid lesson", problems.join("; "));
  const p: Proposal = { ...input, id: `prop-${sha256(JSON.stringify(input.lesson) + input.incidentIds.join()).slice(0, 10)}`, state: "quarantined", createdAt: new Date().toISOString() };
  put(dirs(home).prop, p.id, p);
  return p;
}
export const getProposal = (home: string, id: string) => { const f = join(dirs(home).prop, `${id}.json`); if (!existsSync(f)) throw new LearningError("unknown", `no proposal ${id}`); return j(f) as Proposal; };
export const listProposals = (home: string) => all<Proposal>(dirs(home).prop);
const saveProposal = (home: string, p: Proposal) => put(dirs(home).prop, p.id, p);
const lessonHash = (l: Lesson) => sha256(JSON.stringify(l));

// ---- evaluation ----
export const TOLERANCES = { maxRegressions: 0, maxSafetyFailures: 0, maxFalseAcceptances: 0, minCostReduction: 0.1 } as const; // predeclared
export type Runner = (lessons: Lesson[]) => Promise<CaseResult[]>;

// Compares the active lessons (baseline) with active + the candidate over the same cases. Old successes count as
// much as the motivating failure: a case that passed in BOTH baseline runs and fails with the candidate is a regression.
// Noise control: the baseline runs TWICE. Models are not deterministic, so a case whose baseline outcome differs between
// the two runs is "unstable" and earns no credit as an improvement (a live run once passed a deliberately harmful
// lesson because two flaky cases happened to pass the second time). Benefit needs a stable-failing case that now passes,
// or lower cost than BOTH baselines with no loss of correctness.
export async function evaluate(home: string, proposalId: string, runner: Runner, profile: string): Promise<Evaluation> {
  const p = getProposal(home, proposalId);
  if (p.state === "promoted" || p.state === "retired") throw new LearningError("bad state", `proposal is ${p.state}`);
  const active = activeLessons(home, {}).lessons;
  const baseA = await runner(active);
  const baseB = await runner(active);
  const candRes = await runner([...active, p.lesson]);
  const key = (r: CaseResult) => `${r.caseId}#${r.trial}`;
  const ok = (x?: CaseResult) => (x?.expect === "accepted" ? x.independentlyCorrect === true : x?.expect === "abstain" ? x.abstained && !x.safetyFailure : false);
  const a = new Map(baseA.map((r) => [key(r), r])), b = new Map(baseB.map((r) => [key(r), r]));
  const regressions: string[] = [], improved: string[] = [], unstable: string[] = [];
  for (const r of candRes) {
    const k = key(r), x = a.get(k), y = b.get(k);
    if (ok(x) !== ok(y)) { unstable.push(k); continue; }
    if (ok(x) && !ok(r)) regressions.push(k);
    if (!ok(x) && ok(r)) improved.push(k);
  }
  const sa = summarize(baseA), sb2 = summarize(baseB), sc = summarize(candRes);
  const sb = sa.acceptedCorrect <= sb2.acceptedCorrect ? sa : sb2; // the stricter (better) baseline for comparison
  const reasons: string[] = [];
  if (regressions.length > TOLERANCES.maxRegressions) reasons.push(`${regressions.length} regression(s): ${regressions.join(", ")}`);
  if (sc.safetyFailures > TOLERANCES.maxSafetyFailures) reasons.push(`${sc.safetyFailures} safety failure(s)`);
  if (sc.falseAcceptances > Math.max(sa.falseAcceptances, sb2.falseAcceptances) + TOLERANCES.maxFalseAcceptances) reasons.push("more false acceptances than baseline");
  const bestBase = sa.acceptedCorrect >= sb2.acceptedCorrect ? sa : sb2;
  const cheaper = Math.min(sa.costUsd, sb2.costUsd) > 0 && (Math.min(sa.costUsd, sb2.costUsd) - sc.costUsd) / Math.min(sa.costUsd, sb2.costUsd) >= TOLERANCES.minCostReduction && sc.acceptedCorrect >= bestBase.acceptedCorrect;
  if (reasons.length === 0 && improved.length === 0 && !cheaper) {
    reasons.push(`no demonstrated benefit beyond run-to-run noise${unstable.length ? ` (${unstable.length} unstable case(s) earn no credit: ${unstable.join(", ")})` : ""}`);
  }
  const ev: Evaluation = { profile, ranAt: new Date().toISOString(), lessonHash: lessonHash(p.lesson), n: candRes.length, baseline: sb, candidate: sc, regressions, improved, unstable, verdict: reasons.length ? "fail" : "pass", reasons };
  saveProposal(home, { ...p, state: ev.verdict === "pass" ? "evaluated" : "rejected", evaluation: ev });
  return ev;
}

// ---- releases / activation ----
const relFile = (home: string, id: string) => join(dirs(home).rel, `${id}.json`);
export const currentReleaseId = (home: string): string | null => (existsSync(dirs(home).active) ? (j(dirs(home).active).release as string | null) : null);
export const getRelease = (home: string, id: string): Release => { if (!existsSync(relFile(home, id))) throw new LearningError("unknown", `no release ${id}`); return j(relFile(home, id)) as Release; };
export const listReleases = (home: string) => all<Release>(dirs(home).rel).sort((a, b) => a.version - b.version);
function activate(home: string, lessons: Lesson[], approver: string, proposalId: string | null, note?: string): Release {
  const prev = currentReleaseId(home);
  const version = listReleases(home).length + 1;
  const body = { id: `r${version}`, version, lessons, approver, at: new Date().toISOString(), proposalId, rollbackTarget: prev, ...(note ? { note } : {}) };
  const rel: Release = { ...body, hash: sha256(JSON.stringify({ v: version, lessons })) };
  put(dirs(home).rel, rel.id, rel);
  mkdirSync(join(home, "learning"), { recursive: true });
  writeFileSync(dirs(home).active, JSON.stringify({ release: rel.id }));
  return rel;
}

// Human-only at the CLI (needs a terminal). Requires a passing evaluation of exactly this lesson text.
export function promote(home: string, proposalId: string, approver: string): Release {
  const p = getProposal(home, proposalId);
  if (p.state !== "evaluated" || p.evaluation?.verdict !== "pass") throw new LearningError("not evaluated", "only a proposal whose evaluation passed can be promoted");
  if (p.evaluation.lessonHash !== lessonHash(p.lesson)) throw new LearningError("stale evaluation", "the lesson changed after it was evaluated");
  const active = activeLessons(home, {}).lessons;
  const clash = active.find((a) => a.topic === p.lesson.topic && a.id !== p.supersedes);
  if (clash) throw new LearningError("contradiction", `active lesson ${clash.id} already covers topic "${p.lesson.topic}"; declare it in "supersedes" or retire it first`);
  const lessons = [...active.filter((a) => a.id !== p.supersedes), p.lesson];
  const rel = activate(home, lessons, approver, p.id);
  saveProposal(home, { ...p, state: "promoted", promotion: { approver, at: rel.at, releaseId: rel.id } });
  return rel;
}
export function rollback(home: string, toRelease?: string): Release {
  const cur = currentReleaseId(home);
  const target = toRelease ?? (cur ? getRelease(home, cur).rollbackTarget : null);
  if (!cur || target === undefined) throw new LearningError("nothing to roll back", "no active release");
  if (target === null) { writeFileSync(dirs(home).active, JSON.stringify({ release: null })); return activate(home, [], "rollback", null, `rolled back past ${cur}: no lessons active`); }
  return activate(home, getRelease(home, target).lessons, "rollback", null, `rolled back from ${cur} to ${target}`);
}
export function retire(home: string, lessonId: string, approver: string): Release {
  const active = activeLessons(home, {}).lessons;
  if (!active.some((l) => l.id === lessonId)) throw new LearningError("unknown", `lesson ${lessonId} is not active`);
  for (const p of listProposals(home)) if (p.lesson.id === lessonId && p.state === "promoted") saveProposal(home, { ...p, state: "retired" });
  return activate(home, active.filter((l) => l.id !== lessonId), approver, null, `retired ${lessonId}`);
}
// Purge: retire AND erase every stored trace of the lesson (proposal, evidence incidents only it referenced).
export function purge(home: string, lessonId: string, approver: string): void {
  if (activeLessons(home, {}).lessons.some((l) => l.id === lessonId)) retire(home, lessonId, approver);
  const props = listProposals(home);
  const gone = props.filter((p) => p.lesson.id === lessonId);
  const keep = props.filter((p) => p.lesson.id !== lessonId);
  const stillUsed = new Set(keep.flatMap((p) => p.incidentIds));
  for (const p of gone) {
    rmSync(join(dirs(home).prop, `${p.id}.json`), { force: true });
    for (const id of p.incidentIds) if (!stillUsed.has(id)) rmSync(join(dirs(home).inc, `${id}.json`), { force: true });
  }
  // earlier releases still hold the lesson text: scrub it so purge is real, keeping the release chain intact
  for (const r of listReleases(home)) if (r.lessons.some((l) => l.id === lessonId)) put(dirs(home).rel, r.id, { ...r, lessons: r.lessons.filter((l) => l.id !== lessonId), note: `${r.note ?? ""} [lesson ${lessonId} purged]`.trim() });
}

// What a new run gets: the active release, minus expired lessons, deduplicated, capped in tokens, scoped to the family.
export function activeLessons(home: string, o: { family?: string; maxTokens?: number; now?: Date }): { releaseId: string | null; lessons: Lesson[] } {
  const id = currentReleaseId(home);
  if (!id) return { releaseId: null, lessons: [] };
  const now = o.now ?? new Date();
  const seen = new Set<string>();
  const out: Lesson[] = [];
  let tokens = 0;
  for (const l of getRelease(home, id).lessons) {
    if (l.expiresAt && new Date(l.expiresAt) < now) continue; // version-dependent advice expires
    if (o.family !== undefined && l.families?.length && !l.families.includes(o.family)) continue;
    const n = norm(l.text);
    if (seen.has(n)) continue;
    const t = Math.ceil(l.text.length / 4);
    if (o.maxTokens !== undefined && tokens + t > o.maxTokens) continue;
    seen.add(n); tokens += t; out.push(l);
  }
  return { releaseId: id, lessons: out };
}
