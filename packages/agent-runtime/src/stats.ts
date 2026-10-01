import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog } from "./events.ts";

// Usage statistics computed on demand from what the controller already persists per task ($AGENTIC_HOME/tasks/*):
// the hash-chained event log, the contract and meta.json. Nothing extra is collected and nothing leaves the machine.
// It reports MEASURED spend and outcomes. "Savings" would need a baseline (what the same work costs without the
// runtime), which is not recorded, so none is claimed.
export type TaskStat = {
  id: string; project: string; createdAt?: string; tier?: string; family?: string; state: string;
  tokens: number; costUsd: number; unknownUsageCalls: number; modelCalls: number; repairs: number; rejected: number;
  accepted: boolean; verified: boolean; firstAttempt: boolean; wallMs: number | null;
};
export type Stats = {
  scope: string; tasks: number; byState: Record<string, number>; verified: number; accepted: number; firstAttemptVerified: number;
  abstained: number; inProgress: number; notStarted: number; tokens: number; costUsd: number; unknownUsageCalls: number; modelCalls: number;
  costPerVerified: number | null; tokensPerVerified: number | null; timed: number; medianWallMs: number | null; p90WallMs: number | null;
  byTier: Record<string, { tasks: number; verified: number }>; jev: { decisions: number; fallbacks: number; tokens: number };
  lessons: { release: string | null; count: number };
};

const TERMINAL_BAD = ["BLOCKED", "ESCALATED", "NEEDS_INPUT", "CANCELLED"];

export function readTask(home: string, id: string): TaskStat | null {
  const dir = join(home, "tasks", id);
  const evFile = join(dir, "state", "events.jsonl");
  if (!existsSync(join(dir, "meta.json"))) return null;
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { project: string; createdAt?: string };
  let contract: { riskTier?: string; family?: string } = {};
  try { contract = JSON.parse(readFileSync(join(dir, "contract.json"), "utf8")); } catch { /* keep going without it */ }
  const events = existsSync(evFile) ? new EventLog(evFile).read() : [];
  const states = events.filter((e) => e.type === "state");
  const state = (states.at(-1)?.data as any)?.to ?? "NOT_STARTED";
  let ledger = { tokens: 0, costUsd: 0, unknownUsageCalls: 0, repairs: 0 };
  for (const e of events) {
    const d = e.data as any;
    const l = d?.ledger ?? (e.type === "ledger" ? d : undefined);
    if (l) ledger = { tokens: l.tokens ?? 0, costUsd: l.costUsd ?? 0, unknownUsageCalls: l.unknownUsageCalls ?? 0, repairs: l.repairs ?? 0 };
  }
  const everVerified = states.some((e) => (e.data as any).to === "AWAITING_ACCEPTANCE");
  const stamps = events.map((e) => e.ts).filter((t): t is string => !!t);
  const wallMs = stamps.length >= 2 ? Date.parse(stamps.at(-1)!) - Date.parse(stamps[0]!) : null;
  return {
    id, project: meta.project, ...(meta.createdAt ? { createdAt: meta.createdAt } : {}), ...(contract.riskTier ? { tier: contract.riskTier } : {}),
    ...(contract.family ? { family: contract.family } : {}), state, tokens: ledger.tokens, costUsd: ledger.costUsd,
    unknownUsageCalls: ledger.unknownUsageCalls, modelCalls: events.filter((e) => e.type === "inflight").length, repairs: ledger.repairs,
    rejected: events.filter((e) => e.type === "rejected").length, accepted: state === "ACCEPTED",
    verified: everVerified || state === "ACCEPTED", firstAttempt: (everVerified || state === "ACCEPTED") && ledger.repairs === 0, wallMs,
  };
}

export function allTasks(home: string): TaskStat[] {
  const dir = join(home, "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((id) => { try { const t = readTask(home, id); return t ? [t] : []; } catch { return []; } });
}

const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : null);

export function summarizeTasks(tasks: TaskStat[], scope: string, jevTelemetry: Array<Record<string, any>> = [], lessons = { release: null as string | null, count: 0 }): Stats {
  const byState: Record<string, number> = {};
  const byTier: Stats["byTier"] = {};
  for (const t of tasks) {
    byState[t.state] = (byState[t.state] ?? 0) + 1;
    const b = (byTier[t.tier ?? "unknown"] ??= { tasks: 0, verified: 0 });
    b.tasks += 1; b.verified += t.verified ? 1 : 0;
  }
  const verified = tasks.filter((t) => t.verified).length;
  const tokens = tasks.reduce((a, t) => a + t.tokens, 0), costUsd = tasks.reduce((a, t) => a + t.costUsd, 0);
  const walls = tasks.map((t) => t.wallMs).filter((x): x is number => x !== null);
  const ids = new Set(tasks.map((t) => t.id));
  const jev = jevTelemetry.filter((r) => ids.has(r.taskId));
  return {
    scope, tasks: tasks.length, byState, verified, accepted: tasks.filter((t) => t.accepted).length, firstAttemptVerified: tasks.filter((t) => t.firstAttempt).length,
    abstained: tasks.filter((t) => TERMINAL_BAD.includes(t.state)).length, inProgress: tasks.filter((t) => !t.verified && !TERMINAL_BAD.includes(t.state) && t.state !== "ACCEPTED" && t.state !== "NOT_STARTED").length,
    notStarted: tasks.filter((t) => t.state === "NOT_STARTED").length,
    tokens, costUsd, unknownUsageCalls: tasks.reduce((a, t) => a + t.unknownUsageCalls, 0), modelCalls: tasks.reduce((a, t) => a + t.modelCalls, 0),
    costPerVerified: verified ? costUsd / verified : null, tokensPerVerified: verified ? tokens / verified : null, // ALL tasks' spend over verified candidates
    timed: walls.length, medianWallMs: pct(walls, 0.5), p90WallMs: pct(walls, 0.9), byTier,
    jev: { decisions: jev.filter((r) => r.qid).length, fallbacks: jev.filter((r) => r.fallback || r.fallbackReason && r.fallbackReason !== "shadow").length, tokens: jev.reduce((a, r) => a + (r.usage ? r.usage.input + r.usage.output : 0), 0) },
    lessons,
  };
}

export function formatStats(s: Stats): string {
  const f = (n: number | null, d = 4) => (n === null ? "undefined (no verified task)" : `$${n.toFixed(d)}`);
  const secs = (ms: number | null) => (ms === null ? "n/a" : ms < 60_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 60_000).toFixed(1)}min`);
  const st = Object.entries(s.byState).map(([k, v]) => `${k} ${v}`).join(" · ") || "none";
  return [
    `Usage for ${s.scope}: ${s.tasks} task(s)`,
    `  outcomes: ${st}`,
    `  verified candidates: ${s.verified} (first attempt, no repair: ${s.firstAttemptVerified}) · human-accepted: ${s.accepted} · stopped/abstained: ${s.abstained} · in progress: ${s.inProgress} · not started (e.g. refused before running): ${s.notStarted}`,
    `  model calls ${s.modelCalls} · tokens ${s.tokens.toLocaleString()} · hosted cost $${s.costUsd.toFixed(4)}${s.unknownUsageCalls ? ` · ${s.unknownUsageCalls} call(s) with unknown usage (charged at reservation)` : ""}`,
    `  cost per verified candidate (spend of ALL tasks incl. stopped ones): ${f(s.costPerVerified)}${s.tokensPerVerified === null ? "" : ` · ${Math.round(s.tokensPerVerified).toLocaleString()} tokens`}`,
    `  wall time per task: median ${secs(s.medianWallMs)} · p90 ${secs(s.p90WallMs)} (${s.timed}/${s.tasks} tasks have timing; timing began with this version)`,
    `  by tier: ${Object.entries(s.byTier).map(([k, v]) => `${k} ${v.verified}/${v.tasks} verified`).join(" · ") || "n/a"}`,
    `  Jev: ${s.jev.decisions} decision(s), ${s.jev.fallbacks} fallback(s), ${s.jev.tokens.toLocaleString()} Jev tokens · active lessons: ${s.lessons.count}${s.lessons.release ? ` (release ${s.lessons.release})` : ""}`,
    `  NOT measured: savings. That needs a baseline (the same work done without the runtime); only spend and outcomes are recorded here.`,
  ].join("\n");
}
