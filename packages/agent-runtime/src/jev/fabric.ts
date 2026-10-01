import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonical, sha256 } from "../hash.ts";
import { type DecisionTransport, type JevResult, type Question } from "./client.ts";

// Jev Decision Fabric. Order is fixed: deterministic filtering → allowed candidates → optional Jev → resolver.
// Jev can only choose among options the rules already allow, and a Jev failure never means fewer checks.
export type Mode = "disabled" | "shadow" | "enabled";
export type Family = "workflow-select" | "skill-select" | "retrieval-rerank";
export const FAMILIES: Record<Family, { sendsSource: boolean; failure: "open" | "closed"; consumer: boolean }> = {
  // consumer: whether anything in the runtime can act on an enabled decision yet. Families without one stay shadow-only.
  "workflow-select": { sendsSource: false, failure: "open", consumer: true },
  "skill-select": { sendsSource: false, failure: "open", consumer: false },
  "retrieval-rerank": { sendsSource: true, failure: "open", consumer: false },
};
export const ESCAPES = {
  other: "None of the listed options fits.",
  unknown: "Not enough information to decide.",
  need_more_context: "More context is required before deciding.",
} as const;

export type Calibration = { id: string; family: Family; threshold: number | null; n: number; target: number };
export type Item = { id: string; instructions: string; options: Record<string, string>; rulesDefault: string };
export type Resolved = {
  id: string;
  chosen: string;
  source: "rules" | "jev";
  fallbackReason?: string;
  jevChoice?: string;
  confidence?: number;
  uncalibrated?: boolean;
};
export type FabricPolicy = {
  egress: "local-only" | "hosted-allowed";
  allowSource: boolean;
  modes: Partial<Record<Family, Mode>>;
  pinnedModel?: string;
  // Owner opt-in (jev.allowUncalibrated): act on an enabled family before a calibration exists. Recorded as uncalibrated.
  allowUncalibrated?: boolean;
};

export class Fabric {
  #t: DecisionTransport | undefined;
  #p: FabricPolicy;
  #telemetry: string;
  #cal: Map<Family, Calibration>;
  #cache = new Map<string, JevResult>();
  calls = 0;
  constructor(o: {
    transport?: DecisionTransport;
    policy: FabricPolicy;
    telemetryFile: string;
    calibrations?: Calibration[];
  }) {
    this.#t = o.transport;
    this.#p = o.policy;
    this.#telemetry = o.telemetryFile;
    this.#cal = new Map((o.calibrations ?? []).map((c) => [c.family, c]));
    for (const [f, m] of Object.entries(o.policy.modes)) {
      if (m === "enabled" && !FAMILIES[f as Family]?.consumer)
        throw new Error(
          `family ${f} cannot be enabled: nothing in the runtime consumes its decisions yet (shadow only)`,
        );
    }
  }
  mode(f: Family): Mode {
    return this.#p.modes[f] ?? "disabled";
  }
  #log(rec: Record<string, unknown>) {
    mkdirSync(dirname(this.#telemetry), { recursive: true });
    appendFileSync(this.#telemetry, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
  }

  // `state` is the compact, minimized evidence sent to Jev. Only its hash is stored locally.
  async decide(family: Family, ctx: { taskId: string; state: string; items: Item[] }): Promise<Resolved[]> {
    const rules = (reason?: string): Resolved[] =>
      ctx.items.map((i) => ({
        id: i.id,
        chosen: i.rulesDefault,
        source: "rules",
        ...(reason ? { fallbackReason: reason } : {}),
      }));
    const mode = this.mode(family);
    const spec = FAMILIES[family];
    const base = { family, mode, taskId: ctx.taskId, stateHash: sha256(ctx.state) };
    if (mode === "disabled") return rules();
    // Rules already determine the action when there is nothing to choose between.
    const live = ctx.items.filter((i) => Object.keys(i.options).filter((k) => k !== i.rulesDefault).length > 0);
    if (live.length === 0) {
      this.#log({ ...base, skipped: "rules-determined" });
      return rules();
    }
    if (this.#p.egress !== "hosted-allowed") {
      this.#log({ ...base, skipped: "blocked: egress is local-only" });
      return rules("egress");
    }
    if (spec.sendsSource && !this.#p.allowSource) {
      this.#log({ ...base, skipped: "blocked: family sends source and allowSource is off" });
      return rules("source-egress");
    }
    if (!this.#t) {
      this.#log({ ...base, skipped: "no transport/credential" });
      return rules("unavailable");
    }

    const questions: Record<string, Question> = {};
    for (const i of live) questions[i.id] = { instructions: i.instructions, criteria: { ...i.options, ...ESCAPES } };
    const cal = this.#cal.get(family);
    const key = sha256(
      canonical({ state: ctx.state, questions, cal: cal?.id ?? null, model: this.#p.pinnedModel ?? "alias" }),
    );
    let result = this.#cache.get(key);
    const cached = !!result;
    try {
      if (!result) {
        this.calls += 1;
        result = await this.#t.choice({ state: ctx.state, questions });
        if (this.#p.pinnedModel && result.model !== this.#p.pinnedModel)
          throw Object.assign(new Error(`model ${result.model} is not the pinned ${this.#p.pinnedModel}`), {
            fallback: "model-mismatch",
          });
        this.#cache.set(key, result);
      }
    } catch (e) {
      const reason =
        (e as { fallback?: string }).fallback ??
        ((e as Error).constructor.name === "JevInvalid" ? "invalid-response" : "unavailable");
      this.#log({ ...base, error: (e as Error).message.slice(0, 200), fallback: reason });
      return rules(reason);
    }
    const out: Resolved[] = [];
    for (const i of ctx.items) {
      const a = result.answers[i.id];
      if (!a) {
        out.push({ id: i.id, chosen: i.rulesDefault, source: "rules" });
        continue;
      }
      const allowed = Object.keys(i.options);
      let chosen = i.rulesDefault,
        source: Resolved["source"] = "rules",
        fallbackReason: string | undefined,
        uncalibrated = false;
      if (mode === "shadow") fallbackReason = "shadow";
      else if (!allowed.includes(a.choice)) fallbackReason = a.choice in ESCAPES ? `escape:${a.choice}` : "not-allowed";
      else if ((!cal || cal.threshold === null) && !this.#p.allowUncalibrated) fallbackReason = "uncalibrated";
      else if (cal && cal.threshold !== null && a.confidence < cal.threshold) fallbackReason = "below-threshold";
      else {
        chosen = a.choice;
        source = "jev";
        uncalibrated = !cal || cal.threshold === null;
      }
      out.push({
        id: i.id,
        chosen,
        source,
        ...(fallbackReason ? { fallbackReason } : {}),
        jevChoice: a.choice,
        confidence: a.confidence,
        ...(uncalibrated ? { uncalibrated } : {}),
      });
      this.#log({
        ...base,
        qid: i.id,
        resolvedModel: result.model,
        probabilities: a.probabilities,
        jevChoice: a.choice,
        confidence: a.confidence,
        calibrationId: cal?.id ?? null,
        rulesDefault: i.rulesDefault,
        resolved: chosen,
        source,
        fallbackReason,
        ...(uncalibrated ? { uncalibrated } : {}),
        usage: result.usage,
        latencyMs: result.latencyMs,
        cached,
      });
    }
    return out;
  }
}

export function readTelemetry(file: string): Array<Record<string, any>> {
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
}
export function saveCalibrations(file: string, cals: Calibration[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cals, null, 2));
}
export function loadCalibrations(file: string): Calibration[] {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}
