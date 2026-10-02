import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type Action, InvalidAction, parseAction } from "./actions.ts";
import { Ledger, type Limits } from "./budget.ts";
import { applyEdits } from "./edits.ts";
import { EventLog, unsettledCall } from "./events.ts";
import { type GateResult, type GateSpec, killAllGates, runGate } from "./gates.ts";
import { canonical, sha256 } from "./hash.ts";
import { canMove, type State } from "./machine.ts";
import type { Finding } from "./roles.ts";
import { maxTier, type RiskTier, riskFloor } from "./risk.ts";

export type { RiskTier };
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

export type Policy = {
  workspace: string;
  stateDir: string; // controller state: must be outside the workspace
  protectedPaths: string[];
  writePaths?: string[]; // exact files; a trailing slash grants a directory
  protectExistingTests?: boolean;
  gates: GateSpec[];
  requiredGates: string[];
  limits: Limits;
  egress: "local-only" | "hosted-allowed"; // hosted providers receive source: needs explicit consent
  bootstrap?: GateSpec; // trusted dependency setup (e.g. install from the lockfile)
  baseline?: "require-pass" | "record" | "off"; // run required gates on the untouched candidate first
  riskTier: RiskTier;
  riskTags?: string[]; // sensitive-operation tags from the approved contract (auth, tenancy, financial, ...)
};
export type Evidence = {
  base: string;
  candidate: string;
  policyHash: string;
  gates: GateResult[];
  limitations: string[];
  baseline?: Array<{ gateId: string; status: string }>;
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
  #acceptancePaths: string[] = [];
  feedback = "start";
  readonly contextReads = new Set<string>();

  nextActionId(): string {
    let n = this.#seen.size + 1;
    while (this.#seen.has(`t${n}`)) n++;
    return `t${n}`;
  }

  #checkScope(paths: string[]): void {
    if (!this.#policy.writePaths) return;
    const root = this.#policy.workspace;
    for (const path of paths) {
      const resolved = resolveSafe(root, path);
      if (
        !this.#policy.writePaths.some((p) => {
          const allowed = resolveSafe(root, p);
          return resolved === allowed || (p.endsWith("/") && resolved.startsWith(allowed + sep));
        })
      )
        throw new Error(`outside approved write scope: ${path}`);
    }
  }

  #gate(spec: GateSpec, digest: string): Promise<GateResult> {
    return runGate(
      spec,
      this.#policy.workspace,
      digest,
      join(this.#policy.stateDir, "logs", `${spec.id}-${randomUUID()}.log`),
    );
  }

  #protectedPaths(): string[] {
    return [...this.#policy.protectedPaths, ...this.#acceptancePaths];
  }
  #lastFingerprint = "";
  #baseFiles = new Map<string, string | null>();
  #planHash: string | undefined;
  #draft: Evidence | undefined;
  #viaRecipe = false;
  #prepStop: { to: "NEEDS_INPUT" | "BLOCKED"; why: string } | undefined;
  #baselineDiscovered: Record<string, number> = {};
  #baselineResults: Array<{ gateId: string; status: string }> | undefined;
  #abort = new AbortController();
  uncertainBilling = false; // set on resume when a billable provider call was in flight at the crash
  get signal() {
    return this.#abort.signal;
  }

  get egress() {
    return this.#policy.egress;
  }

  constructor(policy: Policy, opts: { ledger?: Ledger } = {}) {
    const ledger = opts.ledger;
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
    this.#log.append("state", {
      from: this.state,
      to,
      why,
      ledger: this.ledger.snapshot(),
      uncertainBilling: this.uncertainBilling,
    });
    this.state = to;
  }

  // Optional async setup before start(): trusted dependency bootstrap, then the baseline gate run on the untouched
  // candidate. A failure is recorded and applied by start(); nothing runs after a setup failure.
  async prepare(): Promise<void> {
    if (this.state !== "RECEIVED") return;
    const { bootstrap, baseline, requiredGates, gates } = this.#policy;
    if (bootstrap) {
      const b = await this.#gate(bootstrap, "bootstrap");
      this.#log.append("bootstrap", {
        argv: b.argv,
        status: b.status,
        exitCode: b.exitCode,
        durationMs: b.durationMs,
        tail: b.outputTail.slice(-2000),
      });
      if (b.status !== "pass") {
        this.#prepStop = { to: "BLOCKED", why: `environment failure: bootstrap ${b.status}` };
        return;
      }
    }
    if ((baseline ?? "off") === "off") return;
    const results: Array<{ gateId: string; status: string }> = [];
    for (const id of requiredGates) {
      const spec = gates.find((g) => g.id === id);
      if (!spec) throw new Error(`required gate not defined: ${id}`);
      const r = await this.#gate(spec, "baseline");
      this.#log.append("baseline", {
        gateId: id,
        status: r.status,
        discovered: r.discovered,
        tail: r.status === "pass" ? "" : r.outputTail.slice(-1500),
      });
      results.push({ gateId: id, status: r.status });
      if ((r.status === "pass" || r.status === "fail") && r.discovered) this.#baselineDiscovered[id] = r.discovered; // a red baseline still fixes the test count
    }
    this.#baselineResults = results;
    const bad = results.filter((r) => r.status !== "pass");
    if (baseline === "require-pass" && bad.length) {
      this.#prepStop = {
        to: "NEEDS_INPUT",
        why: `pre-existing failures: ${bad.map((r) => `${r.gateId}=${r.status}`).join(", ")} — fix or provide a reviewed baseline`,
      };
    }
  }

  start(): void {
    this.#go("PREFLIGHT");
    const problem = this.#prepStop;
    if (problem) {
      this.#go(problem.to, problem.why);
      return;
    }
    const { workspace, riskTier } = this.#policy;
    this.#base = snapshot(workspace);
    this.#acceptancePaths = this.#policy.protectExistingTests
      ? listFiles(workspace).filter((p) =>
          /(^|\/)(__tests__|tests?|specs?)(\/|$)|[._](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/.test(p),
        )
      : [];
    this.#protectedBase = snapshot(workspace, this.#protectedPaths());
    for (const rel of listFiles(workspace)) this.#baseFiles.set(rel, readText(workspace, rel));
    writeFileSync(
      join(this.#policy.stateDir, "base.json"),
      JSON.stringify({
        base: this.#base,
        protectedBase: this.#protectedBase,
        files: [...this.#baseFiles],
        acceptancePaths: this.#acceptancePaths,
      }),
    );
    this.#log.append("started", { policyHash: sha256(canonical(this.#policy)), candidate: this.#base });
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

  // Billable-call bookkeeping: a crash between begin and end retains the estimate and flags uncertainty.
  beginCall(reserved: number, hosted = true): void {
    this.#log.append("inflight", { reserved, hosted, ledger: this.ledger.snapshot() });
  }
  endCall(): void {
    this.#log.append("ledger", this.ledger.snapshot());
  }

  // Rebuild from the event log + controller state. Verifies the chain, the policy, and the candidate; anything
  // uncertain stops the run rather than being replayed. Billable calls and side effects are never re-issued.
  resume(): void {
    const log = this.#log;
    const events = log.verify();
    if (events.length === 0) throw new Error("nothing to resume");
    let candidate = "";
    let policyHash = "";
    for (const e of events) {
      const d = e.data as Record<string, any>;
      if (e.type === "state") {
        this.state = d.to;
        this.uncertainBilling = d.uncertainBilling ?? false;
        if (d.ledger) this.ledger.restore(d.ledger);
      } else if (e.type === "action") {
        this.#seen.add(d.id);
      } else if (e.type === "started") {
        policyHash = d.policyHash;
        candidate = d.candidate;
      } else if (e.type === "candidate") candidate = d.digest;
      else if (e.type === "plan_approved") this.#planHash = d.planHash;
      else if (e.type === "ledger" || e.type === "inflight" || e.type === "billing_uncertain") {
        this.ledger.restore(d.ledger ?? d);
        if (e.type === "billing_uncertain") this.uncertainBilling = true;
      } else if (e.type === "diagnostic") {
        this.#lastFingerprint = d.fingerprint;
        this.feedback = d.feedback ?? this.feedback;
      } else if (e.type === "review") this.feedback = `Review findings: ${JSON.stringify(d)}`;
      else if (
        e.type === "baseline" &&
        (d.status === "pass" || d.status === "fail") &&
        typeof d.discovered === "number" &&
        d.discovered > 0
      )
        this.#baselineDiscovered[d.gateId] = d.discovered;
    }
    const pending = unsettledCall(events);
    if (pending) {
      this.uncertainBilling = true;
      this.ledger.unknownUsageCalls += 1; // retain the token estimate, not a fabricated dollar charge
      if ((pending.data as { hosted?: boolean }).hosted !== false) this.ledger.unknownCostCalls += 1;
      this.#log.append("billing_uncertain", { ledger: this.ledger.snapshot() });
      if (canMove(this.state, "BLOCKED"))
        this.#go(
          "BLOCKED",
          "uncertain provider call: inspect billing and start a new task; the request will not be replayed",
        );
    }
    const dir = this.#policy.stateDir;
    const saved = JSON.parse(readFileSync(join(dir, "base.json"), "utf8"));
    this.#base = saved.base;
    this.#protectedBase = saved.protectedBase;
    this.#baseFiles = new Map(saved.files);
    this.#acceptancePaths = saved.acceptancePaths ?? [];
    if (existsSync(join(dir, "draft.json"))) this.#draft = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8"));
    if (existsSync(join(dir, "evidence.json")) && (this.state === "AWAITING_ACCEPTANCE" || this.state === "ACCEPTED"))
      this.evidence = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"));
    const live = !["ACCEPTED", "BLOCKED", "ESCALATED", "CANCELLED", "NEEDS_INPUT"].includes(this.state);
    if (live && policyHash !== sha256(canonical(this.#policy))) {
      this.#go("BLOCKED", "stale evidence: policy changed since the run started");
    } else if (live && snapshot(this.#policy.workspace) !== candidate) {
      this.#go("BLOCKED", "stale evidence: workspace differs from the last recorded candidate");
    }
  }

  // After a crash during verification the gates are simply run again (they have no side effects on the run).
  async reverify(): Promise<Outcome> {
    if (this.state !== "VERIFYING") throw new Error(`nothing to re-verify in ${this.state}`);
    return this.#verify();
  }

  // Records a controller-side fact (e.g. which lessons were pinned) in the hash-chained log.
  record(type: string, data: unknown): void {
    this.#log.append(type, data);
  }

  // Explicit approval command. Binds the plan text; a different plan later means a new run/approval.
  approvePlan(approver: string, plan: string): void {
    if (this.state !== "AWAITING_PLAN_APPROVAL") throw new Error("no plan awaiting approval");
    this.#planHash = sha256(plan);
    writeFileSync(
      join(this.#policy.stateDir, "plan.json"),
      JSON.stringify({ approver, planHash: this.#planHash, plan }, null, 2),
    );
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
    this.#log.append("ledger", this.ledger.snapshot());
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
    const { workspace } = this.#policy;
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
      case "edit":
      case "edit_and_finish": {
        this.#checkScope(a.edits.map((e) => e.path));
        if (this.state === "AWAITING_ACCEPTANCE") {
          this.evidence = undefined; // candidate changed: prior evidence is stale
          this.#go("IMPLEMENTING", "edit after verification");
        }
        applyEdits(workspace, a.edits, this.#protectedPaths());
        this.#log.append("candidate", { digest: snapshot(workspace) });
        return a.kind === "edit_and_finish" ? this.#verify() : { ok: true };
      }
      case "run_gate": {
        const spec = this.#policy.gates.find((g) => g.id === a.gateId);
        if (!spec) throw new InvalidAction(`unknown gate: ${a.gateId}`);
        const result = await this.#gate(spec, snapshot(workspace));
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

  async #verify(): Promise<Outcome> {
    if (this.state === "AWAITING_ACCEPTANCE") return { ok: true, data: { state: this.state } };
    if (this.state !== "VERIFYING") this.#go("VERIFYING");
    const { workspace, gates, requiredGates } = this.#policy;
    try {
      this.#checkScope(this.changed().map((c) => c.path));
    } catch (e) {
      this.#go("NEEDS_INPUT", String(e));
      return { ok: false, reason: String(e) };
    }
    if (snapshot(workspace, this.#protectedPaths()) !== this.#protectedBase) {
      this.#go("BLOCKED", "policy violation: protected files changed");
      return { ok: false, reason: "policy violation: protected files changed" };
    }
    const results: GateResult[] = [];
    for (const id of requiredGates) {
      const spec = gates.find((g) => g.id === id);
      if (!spec) throw new Error(`required gate not defined: ${id}`);
      const before = snapshot(workspace);
      let r = await this.#gate(spec, before);
      // A gate that rewrites the candidate certifies bytes it never tested.
      if (r.status === "pass" && snapshot(workspace) !== before)
        r = { ...r, status: "fail", note: "gate modified the candidate; evidence would not match the tested bytes" };
      // Deleting or skipping tests must not pass: fewer discovered tests than the green baseline is a failure.
      const floor = this.#baselineDiscovered[id];
      if (r.status === "pass" && floor !== undefined && (r.discovered ?? 0) < floor) {
        r = {
          ...r,
          status: "fail",
          note: `discovery regression: ${floor} → ${r.discovered ?? 0} (tests removed or skipped)`,
        };
      }
      this.#log.append("gate", r);
      results.push(r);
      if (this.state === "CANCELLED") return { ok: false, reason: "cancelled" };
      if (r.status !== "pass") break;
    }
    if (snapshot(workspace, this.#protectedPaths()) !== this.#protectedBase) {
      this.#go("BLOCKED", "policy violation: protected files changed");
      return { ok: false, reason: "policy violation: protected files changed" };
    }
    const allPass = results.length === requiredGates.length && results.every((r) => r.status === "pass");
    if (!allPass) {
      const bad = results.find((r) => r.status !== "pass")!;
      // Compact diagnostic: gate, status, last 15 output lines. Fingerprint ignores timings and paths' noise.
      const tail = [bad.note, ...bad.outputTail.split("\n").filter(Boolean).slice(-15)].filter(Boolean).join("\n");
      const fingerprint = sha256(`${bad.gateId}|${bad.status}|${tail}`);
      const diagnostic = { gate: bad.gateId, status: bad.status, fingerprint: fingerprint.slice(0, 12), tail };
      this.feedback = `Gate failure: ${JSON.stringify(diagnostic)}`;
      this.#log.append("diagnostic", { fingerprint, feedback: this.feedback });
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
    const floor = paths.length
      ? riskFloor({ paths, tags: this.#policy.riskTags, recipe: this.#viaRecipe })
      : this.#policy.riskTier;
    const tier = maxTier(this.#policy.riskTier, floor);
    if (tier !== this.#policy.riskTier) {
      // the diff is riskier than what was approved: stop for a new contract/approval, never proceed quietly
      this.#go(
        "NEEDS_INPUT",
        `risk floor ${floor} exceeds approved ${this.#policy.riskTier}: re-approve under the higher tier`,
      );
      return { ok: false, reason: `risk floor ${floor} exceeds approved ${this.#policy.riskTier}` };
    }
    this.#draft = {
      base: this.#base,
      candidate,
      policyHash: sha256(canonical(this.#policy)),
      gates: results,
      tier,
      ...(this.#baselineResults ? { baseline: this.#baselineResults } : {}),
      ...(this.#planHash ? { planHash: this.#planHash } : {}),
      limitations: ["candidate checks run on the host in a separate project copy"],
    };
    if (tier === "R2" || tier === "R3") {
      writeFileSync(join(this.#policy.stateDir, "draft.json"), JSON.stringify(this.#draft));
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

  // Gate results of the just-completed verification, available to the reviewer before evidence is final.
  get draftGates(): GateResult[] {
    return this.#draft?.gates ?? [];
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
    this.feedback = `Review findings: ${JSON.stringify(findings)}`;
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

  // Explicit acceptance command; worker JSON actions cannot accept a candidate.
  accept(approver: string): void {
    if (this.state !== "AWAITING_ACCEPTANCE" || !this.evidence) throw new Error("nothing to accept");
    if (snapshot(this.#policy.workspace) !== this.evidence.candidate) {
      this.evidence = undefined;
      this.#go("IMPLEMENTING", "stale evidence: workspace changed after verification");
      throw Object.assign(new Error("stale evidence: candidate changed after verification"), {
        reason: "stale evidence",
      });
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
      id: `recipe-edit-${this.#seen.size}`,
      kind: "edit",
      edits: [{ kind: "replace", path: r.path, expectHash: sha256(current), find: r.find, replace: r.replace }],
    });
    return edit.ok ? this.handle({ id: `recipe-finish-${this.#seen.size}`, kind: "finish" }) : edit;
  }

  // Controller-side stop (driver failures); a model cannot call this.
  stop(to: "BLOCKED" | "ESCALATED" | "NEEDS_INPUT", why: string): void {
    this.#go(to, why);
  }
  // Terminates running gate process groups and aborts in-flight provider calls (billing for those is uncertain).
  cancel(): void {
    this.#abort.abort();
    killAllGates();
    this.#go("CANCELLED");
  }
  close(): void {
    this.#log.close();
  }
}
