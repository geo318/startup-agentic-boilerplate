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
import type { Finding } from "./roles.ts";
import { maxTier, riskFloor } from "./risk.ts";
import { resolveSafe } from "./paths.ts";

const SKIP = new Set([".git", "node_modules"]);

// Digest of every file (tracked or untracked) under the workspace; optionally only some prefixes.
export function snapshot(root: string, only?: string[]): string {
  const files: Record<string, string> = {};
  for (const rel of listFiles(root)) {
    if (!only || only.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`))) {
      files[rel] = sha256(readFileSync(join(root, rel)));
    }
  }
  return sha256(canonical(files));
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

const TEXT_LIMIT = 256 * 1024;
const readText = (root: string, rel: string): string | null => {
  const b = readFileSync(join(root, rel));
  return b.length <= TEXT_LIMIT && !b.includes(0) ? b.toString("utf8") : null;
};

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
  egress: "local-only" | "hosted-allowed"; // hosted providers receive source: needs explicit consent
  dockerImage?: string; // required when isolation is "docker"; no default image
  riskTier: RiskTier;
  riskTags?: string[]; // sensitive-operation tags from the approved contract (auth, tenancy, financial, ...)
};
export type Evidence = {
  base: string;
  candidate: string;
  policyHash: string;
  isolation: Isolation;
  gates: GateResult[];
  limitations: string[];
  tier: RiskTier; // effective tier, recomputed from the actual diff
  planHash?: string;
  findings?: Finding[];
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
  #lastFingerprint = "";
  #baseFiles = new Map<string, string | null>();
  #planHash: string | undefined;
  #draft: Evidence | undefined;
  #viaRecipe = false;

  #dockerUp: () => boolean;
  get egress() {
    return this.#policy.egress;
  }

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
    for (const rel of listFiles(workspace)) this.#baseFiles.set(rel, readText(workspace, rel));
    this.#go("CONTRACT_READY");
    if (riskTier === "R2" || riskTier === "R3") {
      // approved design required before any code is written; approval is an operator action, not a model action
      this.#go("PLANNING");
      this.#go("AWAITING_PLAN_APPROVAL");
      return;
    }
    this.#go("CONTEXT_READY");
    this.#go("IMPLEMENTING");
  }

  // Operator-only. Binds the plan text; a different plan later means a new run/approval.
  approvePlan(approver: string, plan: string): void {
    if (this.state !== "AWAITING_PLAN_APPROVAL") throw new Error("no plan awaiting approval");
    this.#planHash = sha256(plan);
    writeFileSync(join(this.#policy.stateDir, "plan.json"), JSON.stringify({ approver, planHash: this.#planHash, plan }, null, 2));
    this.#log.append("plan_approved", { approver, planHash: this.#planHash });
    this.#go("CONTEXT_READY");
    this.#go("IMPLEMENTING");
  }

  // Files that differ from the start of the run (text only), for reviewers and risk recomputation.
  changed(): Array<{ path: string; before: string | null; after: string | null }> {
    const { workspace } = this.#policy;
    const now = new Set(listFiles(workspace));
    const out: Array<{ path: string; before: string | null; after: string | null }> = [];
    for (const rel of new Set([...this.#baseFiles.keys(), ...now])) {
      const before = this.#baseFiles.has(rel) ? this.#baseFiles.get(rel)! : null;
      const after = now.has(rel) ? readText(workspace, rel) : null;
      if (before !== after) out.push({ path: rel, before, after });
    }
    return out;
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
        let content: string;
        try {
          content = readFileSync(resolveSafe(workspace, a.path), "utf8");
        } catch (e) {
          if ((e as { code?: string }).code === "ENOENT" || (e as { code?: string }).code === "EISDIR") {
            throw Object.assign(new Error(`not found or not a file: ${a.path}`), { reason: "insufficient context" });
          }
          throw e;
        }
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
      const bad = results.find((r) => r.status !== "pass")!;
      // Compact diagnostic: gate, status, last 15 output lines. Fingerprint ignores timings and paths' noise.
      const tail = bad.outputTail.split("\n").filter(Boolean).slice(-15).join("\n");
      const fingerprint = sha256(`${bad.gateId}|${bad.status}|${tail}`);
      const diagnostic = { gate: bad.gateId, status: bad.status, fingerprint: fingerprint.slice(0, 12), tail };
      this.#go("DIAGNOSING");
      if (fingerprint === this.#lastFingerprint) {
        this.#go("ESCALATED", "repeated identical failure without new information");
        return { ok: false, reason: "repeated identical failure", data: diagnostic };
      }
      this.#lastFingerprint = fingerprint;
      try {
        this.ledger.repair();
      } catch {
        this.#go("ESCALATED", "budget exhausted: semantic repairs");
        return { ok: false, reason: "budget exhausted: semantic repairs", data: diagnostic };
      }
      this.#go("BOUNDED_REPAIR");
      return { ok: false, reason: "gates failed", data: diagnostic };
    }
    const candidate = snapshot(workspace);
    const paths = this.changed().map((c) => c.path);
    const floor = paths.length ? riskFloor({ paths, tags: this.#policy.riskTags, recipe: this.#viaRecipe }) : this.#policy.riskTier;
    const tier = maxTier(this.#policy.riskTier, floor);
    if (tier !== this.#policy.riskTier) {
      // the diff is riskier than what was approved: stop for a new contract/approval, never proceed quietly
      this.#go("NEEDS_INPUT", `risk floor ${floor} exceeds approved ${this.#policy.riskTier}: re-approve under the higher tier`);
      return { ok: false, reason: `risk floor ${floor} exceeds approved ${this.#policy.riskTier}` };
    }
    this.#draft = {
      base: this.#base, candidate, policyHash: sha256(canonical(this.#policy)),
      isolation: this.#policy.isolation, gates: results, tier,
      ...(this.#planHash ? { planHash: this.#planHash } : {}),
      limitations: this.#policy.isolation === "none" ? ["user declined docker: candidate code ran on the host with the user's permissions"] : [],
    };
    if (tier === "R2" || tier === "R3") {
      this.#go("REVIEWING"); // independent review is required; the controller runs it and calls completeReview()
      return { ok: true, data: { state: this.state } };
    }
    return this.#finalize([]);
  }

  #finalize(findings: Finding[]): Outcome {
    this.evidence = { ...this.#draft!, ...(findings.length ? { findings } : {}) };
    writeFileSync(join(this.#policy.stateDir, "evidence.json"), JSON.stringify(this.evidence, null, 2));
    this.#go("AWAITING_ACCEPTANCE");
    return { ok: true, data: { state: this.state } };
  }

  // Controller-side: called with validated reviewer findings. Blocking findings send the run to repair.
  completeReview(findings: Finding[]): Outcome {
    if (this.state !== "REVIEWING" || !this.#draft) throw new Error("not awaiting review");
    if (snapshot(this.#policy.workspace) !== this.#draft.candidate) {
      this.#go("DIAGNOSING", "stale evidence: candidate changed during review");
      this.#go("BOUNDED_REPAIR");
      return { ok: false, reason: "stale evidence: candidate changed during review" };
    }
    this.#log.append("review", findings);
    if (findings.some((f) => f.severity === "blocking")) {
      this.#go("DIAGNOSING", "blocking review findings");
      try {
        this.ledger.repair();
      } catch {
        this.#go("ESCALATED", "budget exhausted: semantic repairs");
        return { ok: false, reason: "budget exhausted: semantic repairs", data: findings };
      }
      this.#go("BOUNDED_REPAIR");
      return { ok: false, reason: "blocking review findings", data: findings };
    }
    return this.#finalize(findings);
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

  // R0: a deterministic approved recipe. Zero model calls: the controller builds the edit itself
  // (computing the hash the model would otherwise have to), then verifies like any other run.
  async recipe(r: { path: string; find: string; replace: string }): Promise<Outcome> {
    this.#viaRecipe = true;
    const current = readFileSync(resolveSafe(this.#policy.workspace, r.path), "utf8");
    const edit = await this.handle({
      id: `recipe-edit-${this.#seen.size}`, kind: "edit",
      edits: [{ kind: "replace", path: r.path, expectHash: sha256(current), find: r.find, replace: r.replace }],
    });
    return edit.ok ? this.handle({ id: `recipe-finish-${this.#seen.size}`, kind: "finish" }) : edit;
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
