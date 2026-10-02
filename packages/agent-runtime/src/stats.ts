import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventLog, unsettledCall } from "./events.ts";
import type { SessionRow } from "./session.ts";
import { maxTier, riskFloor, type RiskTier } from "./risk.ts";

// Usage statistics computed on demand from what the controller already persists per task ($AGENTIC_HOME/tasks/*):
// the hash-chained event log, the contract and meta.json. Nothing extra is collected and nothing leaves the machine.
// It reports MEASURED spend and outcomes. "Savings" would need a baseline (what the same work costs without the
// runtime), which is not recorded, so none is claimed.
export type TaskStat = {
  id: string;
  project: string;
  createdAt?: string;
  tier?: string;
  family?: string;
  state: string;
  tokens: number;
  costUsd: number;
  unknownUsageCalls: number;
  unknownCostCalls?: number;
  modelCalls: number;
  repairs: number;
  rejected: number;
  accepted: boolean;
  verified: boolean;
  firstAttempt: boolean;
  wallMs: number | null;
  executionMs: number | null;
};
export type Stats = {
  scope: string;
  tasks: number;
  byState: Record<string, number>;
  verified: number;
  accepted: number;
  firstAttemptVerified: number;
  abstained: number;
  inProgress: number;
  notStarted: number;
  tokens: number;
  tokenAccounting: "reported" | "includes-estimates";
  costUsd: number;
  unknownUsageCalls: number;
  unknownCostCalls?: number;
  modelCalls: number;
  costPerVerified: number | null;
  tokensPerVerified: number | null;
  timed: number;
  medianWallMs: number | null;
  p90WallMs: number | null;
  executionTimed: number;
  medianExecutionMs: number | null;
  p90ExecutionMs: number | null;
  byTier: Record<string, { tasks: number; verified: number }>;
  jev: {
    decisions: number;
    fallbacks: number;
    tokens: number;
    shadow: number; // recorded only, did not influence the run
    acted: number; // Jev's choice was used
    actedUncalibrated: number; // ...under jev.allowUncalibrated, before any calibration existed
    byFamily: Record<string, { decisions: number; acted: number }>;
  };
  sessions: { checked: number; passed: number; failed: number };
  lessons: { release: string | null; count: number };
};

const TERMINAL_BAD = ["BLOCKED", "ESCALATED", "NEEDS_INPUT", "CANCELLED"];

export function readTask(home: string, id: string): TaskStat | null {
  const dir = join(home, "tasks", id);
  const evFile = join(dir, "state", "events.jsonl");
  if (!existsSync(dir)) return null;
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { project: string; createdAt?: string };
  if (!meta || typeof meta.project !== "string" || !meta.project) throw new Error("missing project in meta.json");
  let contract: {
    riskTier?: RiskTier;
    family?: string;
    files?: string[];
    newFiles?: string[];
    scope?: string[];
    riskTags?: string[];
    recipe?: object;
  } = existsSync(join(dir, "contract.json")) ? JSON.parse(readFileSync(join(dir, "contract.json"), "utf8")) : {};
  const events = new EventLog(evFile).verify();
  const revision = events.findLast((e) => e.type === "contract_revised")?.data as
    | { contract: typeof contract }
    | undefined;
  contract = revision?.contract ?? contract;
  const states = events.filter((e) => e.type === "state" || (e.type === "contract_revised" && (e.data as any)?.to));
  const state = (states.at(-1)?.data as any)?.to ?? "NOT_STARTED";
  let ledger = { tokens: 0, costUsd: 0, unknownUsageCalls: 0, unknownCostCalls: 0, repairs: 0 };
  for (const e of events) {
    const d = e.data as any;
    const l = d?.ledger ?? (e.type === "ledger" ? d : undefined);
    if (l)
      ledger = {
        tokens: l.tokens ?? 0,
        costUsd: l.costUsd ?? 0,
        unknownUsageCalls: l.unknownUsageCalls ?? 0,
        unknownCostCalls: l.unknownCostCalls ?? 0,
        repairs: l.repairs ?? 0,
      };
  }
  const pending = unsettledCall(events);
  if (pending) {
    ledger.unknownUsageCalls++;
    if ((pending.data as { hosted?: boolean }).hosted !== false) ledger.unknownCostCalls++;
  }
  // Old resumed logs recorded uncertainty without a dollar counter. Keep those reports conservative.
  const lastState = states.at(-1)?.data as { uncertainBilling?: boolean } | undefined;
  const lastCall = events.findLast((e) => e.type === "inflight")?.data as { hosted?: boolean } | undefined;
  if (lastState?.uncertainBilling && lastCall?.hosted !== false)
    ledger.unknownCostCalls = Math.max(1, ledger.unknownCostCalls);
  if (Object.values(ledger).some((n) => !Number.isFinite(n) || n < 0)) throw new Error("invalid task ledger");
  const verified = state === "AWAITING_ACCEPTANCE" || state === "ACCEPTED";
  const stamps = events.map((e) => (e.ts ? Date.parse(e.ts) : NaN));
  const wallMs =
    stamps.length >= 2 && stamps.every((t, i) => Number.isFinite(t) && (i === 0 || t >= stamps[i - 1]!))
      ? stamps.at(-1)! - stamps[0]!
      : null;
  let executionMs = 0,
    executing = false;
  let completeTiming = events[0]?.type === "execution_started";
  for (const e of events) {
    if (e.type === "execution_started") {
      if (executing) completeTiming = false;
      executing = true;
    } else if (e.type === "execution_finished") {
      const ms = (e.data as { durationMs?: number }).durationMs;
      if (!executing || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) completeTiming = false;
      else executionMs += ms;
      executing = false;
    }
  }
  return {
    id,
    project: meta.project,
    ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
    ...(contract.riskTier
      ? {
          tier: maxTier(
            contract.riskTier,
            riskFloor({
              paths: contract.scope ?? [...(contract.files ?? []), ...(contract.newFiles ?? [])],
              tags: contract.riskTags,
              recipe: !!contract.recipe,
            }),
          ),
        }
      : {}),
    ...(contract.family ? { family: contract.family } : {}),
    state,
    tokens: ledger.tokens,
    costUsd: ledger.costUsd,
    unknownUsageCalls: ledger.unknownUsageCalls,
    unknownCostCalls: ledger.unknownCostCalls,
    modelCalls: events.filter((e) => e.type === "inflight").length,
    repairs: ledger.repairs,
    rejected: events.filter((e) => e.type === "rejected").length,
    accepted: state === "ACCEPTED",
    verified,
    firstAttempt: verified && ledger.repairs === 0,
    wallMs,
    executionMs: completeTiming && !executing ? executionMs : null,
  };
}

export function allTasks(home: string): TaskStat[] {
  const dir = join(home, "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap(({ name: id }) => {
      try {
        const t = readTask(home, id);
        return t ? [t] : [];
      } catch (e) {
        throw new Error(
          `Cannot report complete stats: task ${id} at ${join(dir, id)}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
}

const pct = (xs: number[], q: number) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]! : null;

export function summarizeTasks(
  tasks: TaskStat[],
  scope: string,
  jevTelemetry: Array<Record<string, any>> = [],
  lessons = { release: null as string | null, count: 0 },
  sessions: SessionRow[] = [],
): Stats {
  const byState: Record<string, number> = {};
  const byTier: Stats["byTier"] = {};
  for (const t of tasks) {
    byState[t.state] = (byState[t.state] ?? 0) + 1;
    const b = (byTier[t.tier ?? "unknown"] ??= { tasks: 0, verified: 0 });
    b.tasks += 1;
    b.verified += t.verified ? 1 : 0;
  }
  const verified = tasks.filter((t) => t.verified).length;
  const tokens = tasks.reduce((a, t) => a + t.tokens, 0),
    costUsd = tasks.reduce((a, t) => a + t.costUsd, 0);
  const walls = tasks.map((t) => t.wallMs).filter((x): x is number => x !== null);
  const executions = tasks
    .map((t) => t.executionMs)
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const ids = new Set(tasks.map((t) => t.id));
  const jev = jevTelemetry.filter((r) => ids.has(r.taskId));
  return {
    scope,
    tasks: tasks.length,
    byState,
    verified,
    accepted: tasks.filter((t) => t.accepted).length,
    firstAttemptVerified: tasks.filter((t) => t.firstAttempt).length,
    abstained: tasks.filter((t) => TERMINAL_BAD.includes(t.state)).length,
    inProgress: tasks.filter(
      (t) => !t.verified && !TERMINAL_BAD.includes(t.state) && t.state !== "ACCEPTED" && t.state !== "NOT_STARTED",
    ).length,
    notStarted: tasks.filter((t) => t.state === "NOT_STARTED").length,
    tokens,
    tokenAccounting: tasks.some((t) => t.unknownUsageCalls) ? "includes-estimates" : "reported",
    costUsd,
    unknownUsageCalls: tasks.reduce((a, t) => a + t.unknownUsageCalls, 0),
    unknownCostCalls: tasks.reduce((a, t) => a + (t.unknownCostCalls ?? 0), 0),
    modelCalls: tasks.reduce((a, t) => a + t.modelCalls, 0),
    costPerVerified: verified && !tasks.some((t) => t.unknownCostCalls) ? costUsd / verified : null,
    tokensPerVerified: verified && !tasks.some((t) => t.unknownUsageCalls) ? tokens / verified : null,
    timed: walls.length,
    medianWallMs: pct(walls, 0.5),
    p90WallMs: pct(walls, 0.9),
    executionTimed: executions.length,
    medianExecutionMs: pct(executions, 0.5),
    p90ExecutionMs: pct(executions, 0.9),
    byTier,
    jev: {
      decisions: jev.filter((r) => r.qid).length,
      fallbacks: jev.filter((r) => r.fallback || (r.fallbackReason && r.fallbackReason !== "shadow")).length,
      tokens: jev.reduce((a, r) => a + (r.usage ? r.usage.input + r.usage.output : 0), 0),
      shadow: jev.filter((r) => r.qid && r.mode === "shadow").length,
      acted: jev.filter((r) => r.source === "jev").length,
      actedUncalibrated: jev.filter((r) => r.source === "jev" && r.uncalibrated).length,
      byFamily: jev
        .filter((r) => r.qid)
        .reduce<Record<string, { decisions: number; acted: number }>>((a, r) => {
          const x = (a[r.family] ??= { decisions: 0, acted: 0 });
          x.decisions += 1;
          if (r.source === "jev") x.acted += 1;
          return a;
        }, {}),
    },
    sessions: {
      checked: sessions.length,
      passed: sessions.filter((r) => r.passed).length,
      failed: sessions.filter((r) => !r.passed).length,
    },
    lessons,
  };
}

export function formatStats(s: Stats): string {
  const f = (n: number | null, d = 4) =>
    n === null ? "undefined (no verified task or incomplete billing)" : `$${n.toFixed(d)}`;
  const secs = (ms: number | null) =>
    ms === null ? "n/a" : ms < 60_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 60_000).toFixed(1)}min`;
  const st =
    Object.entries(s.byState)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ") || "none";
  return [
    `Usage for ${s.scope}: ${s.tasks} task(s)`,
    `  outcomes: ${st}`,
    `  verified candidates: ${s.verified} (first attempt, no repair: ${s.firstAttemptVerified}) · operator-accepted: ${s.accepted} · stopped/abstained: ${s.abstained} · in progress: ${s.inProgress} · not started (e.g. refused before running): ${s.notStarted}`,
    `  model calls ${s.modelCalls} · ${s.unknownUsageCalls ? "budget-accounted tokens (includes estimates)" : "reported tokens"} ${s.tokens.toLocaleString()} · reported hosted cost $${s.costUsd.toFixed(4)}${s.unknownCostCalls ? ` · INCOMPLETE: ${s.unknownCostCalls} call(s) with unknown cost` : ""}${s.unknownUsageCalls ? ` · ${s.unknownUsageCalls} call(s) with unknown usage (estimated at reservation)` : ""}`,
    `  cost per verified candidate (spend of ALL tasks incl. stopped ones): ${f(s.costPerVerified)}${s.tokensPerVerified === null ? "" : ` · ${Math.round(s.tokensPerVerified).toLocaleString()} tokens`}`,
    `  elapsed time (includes approval/idle waits, first to last recorded event): median ${secs(s.medianWallMs)} · p90 ${secs(s.p90WallMs)} (${s.timed}/${s.tasks} tasks timed)`,
    `  task-run execution (excludes waits between invocations): median ${secs(s.medianExecutionMs)} · p90 ${secs(s.p90ExecutionMs)} (${s.executionTimed}/${s.tasks} tasks have complete execution timing)`,
    `  by tier: ${
      Object.entries(s.byTier)
        .map(([k, v]) => `${k} ${v.verified}/${v.tasks} verified`)
        .join(" · ") || "n/a"
    }`,
    `  Jev: ${s.jev.decisions} decision(s) (${s.jev.shadow} shadow-only, ${s.jev.acted} acted on${s.jev.actedUncalibrated ? `, ${s.jev.actedUncalibrated} before calibration` : ""}), ${s.jev.fallbacks} fallback(s), ${s.jev.tokens.toLocaleString()} Jev tokens${Object.entries(
      s.jev.byFamily,
    )
      .map(([k, v]) => ` · ${k} ${v.acted}/${v.decisions} acted`)
      .join("")}`,
    `  recorded session checks (manual or Stop hook; no model driven): ${s.sessions.checked} (${s.sessions.passed} passed, ${s.sessions.failed} failed)`,
    `  active lessons: ${s.lessons.count}${s.lessons.release ? ` (release ${s.lessons.release})` : ""}`,
    `  Scope: managed task model calls only; ordinary chat and standalone qualification costs are not included. Jev usage is separate.`,
    `  NOT measured: savings. That needs a baseline (the same work done without the runtime); only spend and outcomes are recorded here.`,
  ].join("\n");
}
