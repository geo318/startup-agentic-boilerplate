import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type Action, InvalidAction, parseAction } from "./actions.ts";
import { Ledger, type Limits } from "./budget.ts";
import { applyEdits } from "./edits.ts";
import { EventLog } from "./events.ts";
import { spawnSync } from "node:child_process";
import { type GateResult, type GateSpec, runGate } from "./gates.ts";
import { canonical, sha256 } from "./hash.ts";
import { canMove, type State } from "./machine.ts";
import { resolveSafe } from "./paths.ts";

const SKIP = new Set([".git", "node_modules"]);

// Digest of every file (tracked or untracked) under the workspace; optionally only some prefixes.
export function snapshot(root: string, only?: string[]): string {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        if (!only || only.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`))) {
          files[rel] = sha256(readFileSync(full));
        }
      }
    }
  };
  walk(root);
  return sha256(canonical(files));
}

// "unset" = the user has not answered the isolation question yet; the run stops and asks.
export type Isolation = "unset" | "none" | "docker";
export type RiskTier = "R0" | "R1" | "R2" | "R3";
export type Policy = {
  workspace: string;
  stateDir: string; // controller state: must be outside the workspace
  protectedPaths: string[];
  gates: GateSpec[];
  requiredGates: string[];
  limits: Limits;
  isolation: Isolation;
  dockerImage?: string; // required when isolation is "docker"; no default image
  riskTier: RiskTier;
};
export type Evidence = {
  base: string;
  candidate: string;
  policyHash: string;
  isolation: Isolation;
  gates: GateResult[];
  limitations: string[];
};
export type Outcome = { ok: boolean; reason?: string; data?: unknown };

export class Run {
  state: State = "RECEIVED";
  evidence: Evidence | undefined;
  readonly ledger: Ledger;
  #policy: Policy;
  #log: EventLog;
  #base = "";
  #protectedBase = "";
  #seen = new Set<string>();

  #dockerUp: () => boolean;

  constructor(policy: Policy, opts: { ledger?: Ledger; dockerUp?: () => boolean } = {}) {
    const ledger = opts.ledger;
    this.#dockerUp = opts.dockerUp ?? (() => spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0);
    if (policy.stateDir === policy.workspace || policy.stateDir.startsWith(policy.workspace + sep)) {
      throw new Error("stateDir must be outside the workspace");
    }
    this.#policy = policy;
    this.ledger = ledger ?? new Ledger(policy.limits);
    mkdirSync(policy.stateDir, { recursive: true });
    this.#log = new EventLog(join(policy.stateDir, "events.jsonl")).open();
  }

  #go(to: State, why?: string) {
    if (!canMove(this.state, to)) throw new Error(`illegal transition ${this.state} → ${to}`);
    this.#log.append("state", { from: this.state, to, why });
    this.state = to;
  }

  // Preflight. The isolation choice is the user's: unanswered → stop and ask; "none" is allowed only
  // for R0–R2; "docker" is verified up front and never silently falls back to the host.
  start(): void {
    this.#go("PREFLIGHT");
    const { isolation, riskTier, dockerImage } = this.#policy;
    if (isolation === "unset") {
      this.#go("NEEDS_INPUT", "isolation not chosen: ask the user (docker yes/no)");
      return;
    }
    if (isolation === "none" && riskTier === "R3") {
      this.#go("BLOCKED", "policy violation: R3 work requires isolation or human-run checks");
      return;
    }
    if (isolation === "docker" && (!dockerImage || !this.#dockerUp())) {
      this.#go("BLOCKED", "environment failure: docker chosen but image unset or daemon unreachable");
      return;
    }
    const { workspace, protectedPaths } = this.#policy;
    this.#base = snapshot(workspace);
    this.#protectedBase = snapshot(workspace, protectedPaths);
    this.#go("CONTRACT_READY");
    this.#go("CONTEXT_READY");
    this.#go("IMPLEMENTING");
  }

  async handle(raw: unknown): Promise<Outcome> {
    let action: Action;
    try {
      action = parseAction(raw);
      if (this.#seen.has(action.id)) throw new InvalidAction(`duplicate action id ${action.id}`);
      this.#seen.add(action.id);
    } catch (e) {
      return this.#reject(e);
    }
    if (!["IMPLEMENTING", "BOUNDED_REPAIR", "AWAITING_ACCEPTANCE"].includes(this.state)) {
      return this.#reject(new Error(`no actions accepted in ${this.state}`));
    }
    try {
      this.ledger.action();
    } catch (e) {
      this.#go("ESCALATED", "budget exhausted");
      return this.#reject(e);
    }
    this.#log.append("action", action);
    try {
      return await this.#dispatch(action);
    } catch (e) {
      return this.#reject(e);
    }
  }

  #reject(e: unknown): Outcome {
    const reason = (e as { reason?: string }).reason ?? "policy violation";
    const message = e instanceof Error ? e.message : String(e);
    this.#log.append("rejected", { reason, message });
    return { ok: false, reason: `${reason}: ${message}` };
  }

  async #dispatch(a: Action): Promise<Outcome> {
    const { workspace, protectedPaths } = this.#policy;
    switch (a.kind) {
      case "read": {
        const content = readFileSync(resolveSafe(workspace, a.path), "utf8");
        return { ok: true, data: { content, hash: sha256(content) } };
      }
      case "edit": {
        if (this.state === "AWAITING_ACCEPTANCE") {
          this.evidence = undefined; // candidate changed: prior evidence is stale
          this.#go("IMPLEMENTING", "edit after verification");
        }
        applyEdits(workspace, a.edits, protectedPaths);
        return { ok: true };
      }
      case "run_gate": {
        const spec = this.#policy.gates.find((g) => g.id === a.gateId);
        if (!spec) throw new InvalidAction(`unknown gate: ${a.gateId}`);
        const result = await runGate(spec, workspace, snapshot(workspace), this.#sandbox());
        this.#log.append("gate", result);
        return { ok: true, data: { status: result.status, discovered: result.discovered } }; // informational only
      }
      case "blocked":
        this.#go("BLOCKED", a.reason);
        return { ok: true };
      case "finish":
        return this.#verify();
    }
  }

  #sandbox() {
    return this.#policy.isolation === "docker" ? { image: this.#policy.dockerImage! } : undefined;
  }

  async #verify(): Promise<Outcome> {
    if (this.state === "AWAITING_ACCEPTANCE") return { ok: true, data: { state: this.state } };
    this.#go("VERIFYING");
    const { workspace, protectedPaths, gates, requiredGates } = this.#policy;
    const results: GateResult[] = [];
    for (const id of requiredGates) {
      const spec = gates.find((g) => g.id === id);
      if (!spec) throw new Error(`required gate not defined: ${id}`);
      const r = await runGate(spec, workspace, snapshot(workspace), this.#sandbox());
      this.#log.append("gate", r);
      results.push(r);
      if (r.status !== "pass") break;
    }
    if (snapshot(workspace, protectedPaths) !== this.#protectedBase) {
      this.#go("BLOCKED", "policy violation: protected files changed");
      return { ok: false, reason: "policy violation: protected files changed" };
    }
    const allPass = results.length === requiredGates.length && results.every((r) => r.status === "pass");
    if (!allPass) {
      this.#go("DIAGNOSING");
      try {
        this.ledger.repair();
      } catch {
        this.#go("ESCALATED", "budget exhausted: semantic repairs");
        return { ok: false, reason: "budget exhausted: semantic repairs", data: results.map((r) => [r.gateId, r.status]) };
      }
      this.#go("BOUNDED_REPAIR");
      return { ok: false, reason: "gates failed", data: results.map((r) => [r.gateId, r.status]) };
    }
    const candidate = snapshot(workspace);
    this.evidence = {
      base: this.#base, candidate, policyHash: sha256(canonical(this.#policy)),
      isolation: this.#policy.isolation, gates: results,
      limitations: this.#policy.isolation === "none" ? ["user declined docker: candidate code ran on the host with the user's permissions"] : [],
    };
    writeFileSync(join(this.#policy.stateDir, "evidence.json"), JSON.stringify(this.evidence, null, 2));
    this.#go("AWAITING_ACCEPTANCE");
    return { ok: true, data: { state: this.state } };
  }

  // Operator-only: deliberately not an Action kind, so a model cannot reach it.
  accept(approver: string): void {
    if (this.state !== "AWAITING_ACCEPTANCE" || !this.evidence) throw new Error("nothing to accept");
    if (snapshot(this.#policy.workspace) !== this.evidence.candidate) {
      this.evidence = undefined;
      this.#go("IMPLEMENTING", "stale evidence: workspace changed after verification");
      throw Object.assign(new Error("stale evidence: candidate changed after verification"), { reason: "stale evidence" });
    }
    this.#log.append("accepted", { approver, candidate: this.evidence.candidate });
    this.#go("ACCEPTED");
  }

  // Controller-side stop (driver failures); a model cannot call this.
  stop(to: "BLOCKED" | "ESCALATED" | "NEEDS_INPUT", why: string): void {
    this.#go(to, why);
  }
  cancel(): void {
    this.#go("CANCELLED");
  }
  close(): void {
    this.#log.close();
  }
}
