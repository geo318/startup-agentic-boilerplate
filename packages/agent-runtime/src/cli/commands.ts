import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, type Limits } from "../budget.ts";
import { ChatCompletionsProvider } from "../chat.ts";
import { ClaudeCliProvider } from "../claude.ts";
import { askIsolation, loadChoice, saveChoice } from "../consent.ts";
import { compile, render } from "../context.ts";
import { drive } from "../drive.ts";
import { EventLog } from "../events.ts";
import { sha256 } from "../hash.ts";
import { ManualProvider } from "../manual.ts";
import { OllamaProvider } from "../ollama.ts";
import { type GenerationProvider, MockProvider } from "../provider.ts";
import { QualStore, selectProfile } from "../qualify.ts";
import { maxTier, riskFloor } from "../risk.ts";
import { architect, review, RoleFailed } from "../roles.ts";
import { type Policy, Run, type RiskTier } from "../run.ts";
import { validate } from "../schema.ts";

export type Env = {
  home: string; // controller state (tasks, qualifications): outside every project
  project: string;
  out: (s: string) => void;
  operatorTty: boolean; // true only when a human is at an interactive terminal
  ask: (q: string) => Promise<string>;
  user: string;
  dockerUp?: () => boolean;
  onRun?: (run: Run) => void; // lets main wire SIGINT → run.cancel()
};

export class CliError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

const SCHEMAS = join(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..", "schemas");
const BUDGETS: Record<string, { limits: Limits; maxContext: number; maxOut: number }> = {
  narrow: { limits: { aggregateTokens: 12_000, toolActions: 6, semanticRepairs: 1 }, maxContext: 4000, maxOut: 1500 },
  standard: { limits: { aggregateTokens: 40_000, toolActions: 12, semanticRepairs: 1 }, maxContext: 8000, maxOut: 3000 },
  complex: { limits: { aggregateTokens: 100_000, toolActions: 24, semanticRepairs: 1 }, maxContext: 16000, maxOut: 6000 },
};

function loadValidated<T>(file: string, schemaName: string): T {
  if (!existsSync(file)) throw new CliError(`missing file: ${file}`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new CliError(`not valid JSON: ${file}`);
  }
  const schema = JSON.parse(readFileSync(join(SCHEMAS, `${schemaName}.schema.json`), "utf8"));
  const errs = validate(schema, data);
  if (errs.length) throw new CliError(`${file} is invalid:\n  ${errs.slice(0, 10).join("\n  ")}`);
  return data as T;
}

type Contract = {
  id: string; goal: string; acceptance: string[]; files: string[]; scope?: string[]; riskTier: RiskTier; riskTags?: string[];
  budget: "narrow" | "standard" | "complex"; recipe?: { path: string; find: string; replace: string }; unresolvedQuestions?: string[];
};
type ProjectPolicy = {
  protectedPaths: string[]; gates: Policy["gates"]; requiredGates: string[]; egress: Policy["egress"]; dockerImage?: string;
  bootstrap?: { argv: string[]; timeoutMs: number; env?: Record<string, string> }; baseline?: "require-pass" | "record" | "off";
};
type Models = { profiles: Record<string, Record<string, any>>; roles: { worker: string; architect?: string; reviewer?: string } };

// Copies what git considers part of the project (tracked + untracked, minus ignored): no build output, no .env.
// Without git it falls back to excluding the usual heavy directories.
function copyProject(src: string, dest: string): void {
  const r = spawnSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd: src, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    cpSync(src, dest, { recursive: true, filter: (p) => !/(^|\/)(\.git|node_modules|\.next|dist|build|\.agentic)(\/|$)/.test(p.slice(src.length)) });
    return;
  }
  mkdirSync(dest, { recursive: true });
  for (const rel of r.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const from = join(src, rel);
    let st;
    try {
      st = lstatSync(from);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to); // links stay links, never followed
    else if (st.isFile()) copyFileSync(from, to);
    // anything else (gitlinks/submodule dirs, sockets) is not project content we copy
  }
}

const taskDir = (env: Env, id: string) => join(env.home, "tasks", id);
const stateOf = (env: Env, id: string) => join(taskDir(env, id), "state");
const projectFile = (env: Env, ...p: string[]) => join(env.project, ".agents", ...p);

function makeProvider(env: Env, name: string, models: Models): GenerationProvider {
  const p = models.profiles[name];
  if (!p) throw new CliError(`profile not defined: ${name}`);
  switch (p.kind) {
    case "claude-cli": return new ClaudeCliProvider({ model: p.model, maxBudgetUsd: p.maxBudgetUsd ?? 0.05, timeoutMs: p.timeoutMs ?? 120_000 });
    case "ollama": return new OllamaProvider({ baseUrl: p.baseUrl, model: p.model, numCtx: p.numCtx ?? 4096, temperature: 0, timeoutMs: p.timeoutMs ?? 120_000 });
    case "chat-completions": return new ChatCompletionsProvider({ baseUrl: p.baseUrl, model: p.model, hosted: p.hosted, apiKeyEnv: p.apiKeyEnv, supportsJsonSchema: p.supportsJsonSchema ?? false, temperature: 0, timeoutMs: p.timeoutMs ?? 120_000 });
    case "manual": return new ManualProvider(p.dir, p.label, p.timeoutMs);
    case "replay": return Object.assign(new MockProvider(JSON.parse(readFileSync(p.file, "utf8"))), { id: `mock/replay:${basename(p.file)}` });
  }
  throw new CliError(`unsupported profile kind: ${p.kind}`);
}

// ---------------- commands ----------------

export async function doctor(env: Env): Promise<number> {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  const rows: Array<[string, string]> = [
    ["node", maj > 22 || (maj === 22 && min >= 18) ? `ok ${process.versions.node}` : `FAIL ${process.versions.node} (need ≥22.18)`],
    ["git", spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0 ? "ok" : "missing"],
    ["docker (optional)", (env.dockerUp ?? (() => spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0))() ? "daemon reachable" : "not available (only needed if you choose Docker isolation)"],
  ];
  for (const [file, schema] of [["policy.json", "policy"], ["models.json", "models"]] as const) {
    const f = projectFile(env, file);
    if (!existsSync(f)) { rows.push([file, "absent"]); continue; }
    try { loadValidated(f, schema); rows.push([file, "valid"]); } catch (e) { rows.push([file, `INVALID ${(e as Error).message.split("\n")[1]?.trim() ?? ""}`]); }
  }
  rows.push(["qualifications", `${new QualStore(join(env.home, "qualifications.json")).all().filter((q) => q.passed).length} passed`]);
  for (const [k, v] of rows) env.out(`${k.padEnd(20)} ${v}`);
  return rows.some(([, v]) => v.startsWith("FAIL") || v.startsWith("INVALID")) ? 1 : 0;
}

export async function validateFiles(env: Env, contracts: string[]): Promise<number> {
  let bad = 0;
  const check = (f: string, s: string) => {
    try { loadValidated(f, s); env.out(`ok       ${f}`); } catch (e) { bad += 1; env.out(`INVALID  ${(e as Error).message}`); }
  };
  if (existsSync(projectFile(env, "policy.json"))) check(projectFile(env, "policy.json"), "policy");
  if (existsSync(projectFile(env, "models.json"))) check(projectFile(env, "models.json"), "models");
  for (const c of contracts) check(c, "task-contract");
  return bad ? 1 : 0;
}

export async function taskCreate(env: Env, file: string): Promise<number> {
  const c = loadValidated<Contract>(file, "task-contract");
  const dir = taskDir(env, c.id);
  if (existsSync(dir)) throw new CliError(`task already exists: ${c.id}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "contract.json"), JSON.stringify(c, null, 2));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ project: env.project }, null, 2));
  env.out(`created task ${c.id} (${c.riskTier}, budget ${c.budget})`);
  return 0;
}

function load(env: Env, id: string) {
  const dir = taskDir(env, id);
  if (!existsSync(join(dir, "contract.json"))) throw new CliError(`no such task: ${id}`);
  const contract = loadValidated<Contract>(join(dir, "contract.json"), "task-contract");
  const pp = loadValidated<ProjectPolicy>(projectFile(env, "policy.json"), "policy");
  const mf = projectFile(env, "models.json");
  const models = () => (existsSync(mf) ? loadValidated<Models>(mf, "models") : undefined); // lazy: R0 recipes need no models
  const budget = BUDGETS[contract.budget]!;
  const candidate = join(dir, "candidate");
  const stateDir = stateOf(env, id);
  const scopeFloor = contract.scope?.length ? riskFloor({ paths: contract.scope, tags: contract.riskTags, recipe: !!contract.recipe }) : contract.riskTier;
  const tier = maxTier(contract.riskTier, scopeFloor);
  const base = { contract, pp, models, budget, dir, candidate, stateDir, tier };
  const policy = (isolation: Policy["isolation"]): Policy => ({
    workspace: candidate, stateDir, protectedPaths: pp.protectedPaths, gates: pp.gates, requiredGates: pp.requiredGates,
    limits: budget.limits, isolation, egress: pp.egress, ...(pp.dockerImage ? { dockerImage: pp.dockerImage } : {}),
    riskTier: tier, ...(contract.riskTags?.length ? { riskTags: contract.riskTags } : {}),
    baseline: pp.baseline ?? "require-pass", // a candidate is only judged against a green starting point
    ...(pp.bootstrap ? { bootstrap: { id: "bootstrap", argv: pp.bootstrap.argv, timeoutMs: pp.bootstrap.timeoutMs, discover: { regex: "", min: 0 }, ...(pp.bootstrap.env ? { env: pp.bootstrap.env } : {}) } } : {}),
  });
  return { ...base, policy };
}

export function statusOf(env: Env, id: string) {
  const events = new EventLog(join(stateOf(env, id), "events.jsonl")).read();
  const last = [...events].reverse().find((e) => e.type === "state");
  const ledger = [...events].reverse().map((e) => (e.data as any)?.ledger ?? (e.type === "ledger" ? e.data : undefined)).find(Boolean);
  return { state: (last?.data as any)?.to ?? "NOT_STARTED", why: (last?.data as any)?.why, events: events.length, ledger };
}

const EXIT: Record<string, number> = { AWAITING_ACCEPTANCE: 0, ACCEPTED: 0, NEEDS_INPUT: 2, AWAITING_PLAN_APPROVAL: 2 };

export async function taskRun(env: Env, id: string): Promise<number> {
  const t = load(env, id);
  if (t.contract.unresolvedQuestions?.length) throw new CliError(`unresolved design decision: ${t.contract.unresolvedQuestions.join("; ")}`);
  const fresh = !existsSync(join(t.stateDir, "events.jsonl"));

  let iso = loadChoice(t.stateDir);
  if (!iso) {
    if (!env.operatorTty) {
      env.out("Isolation choice needed. Run `agentic task run " + id + "` from an interactive terminal to answer (Docker yes/no). Nothing was run.");
      return 2;
    }
    iso = await askIsolation(env.ask);
    if (!iso) { env.out("No valid answer (yes/no). Nothing was run."); return 2; }
    saveChoice(t.stateDir, iso);
  }

  // Providers and qualifications are checked before any state is created: a task we cannot route has no side effects.
  const store = new QualStore(join(env.home, "qualifications.json"));
  const usesModel = !(t.tier === "R0" && t.contract.recipe);
  const providers: { worker?: GenerationProvider; architect?: GenerationProvider; reviewer?: GenerationProvider } = {};
  if (usesModel) {
    const models = t.models();
    if (!models) throw new CliError("no .agents/models.json: configure a worker profile (see schemas/models.schema.json)");
    const wanted: Array<["worker" | "architect" | "reviewer", boolean]> = [["worker", true], ["architect", t.tier === "R2" || t.tier === "R3"], ["reviewer", t.tier === "R2" || t.tier === "R3"]];
    for (const [role, needed] of wanted) {
      if (!needed) continue;
      const name = models.roles[role];
      if (!name) throw new CliError(`no ${role} profile configured for a ${t.tier} task`);
      const sel = selectProfile(role, t.tier, [makeProvider(env, name, models)], store);
      if (!sel.ok) throw new CliError(`${sel.reason} (profile "${name}"). Qualify it first: agentic qualify ${name}`);
      providers[role] = sel.provider;
    }
  }

  if (fresh) {
    rmSync(t.candidate, { recursive: true, force: true }); // a crashed earlier copy must not leak into this one
    copyProject(env.project, t.candidate);
  }
  const run = new Run(t.policy(iso), env.dockerUp ? { dockerUp: env.dockerUp } : {});
  env.onRun?.(run);
  try {
    if (fresh) {
      await run.prepare();
      run.start();
    } else run.resume();
    if (run.state === "VERIFYING") await run.reverify();
    const planFile = join(t.dir, "plan.json");
    const ctxText = () => render(compile(t.candidate, t.contract.files, t.budget.maxContext));
    const roleCtx = (p: GenerationProvider) => ({ provider: p, ledger: run.ledger, egress: t.pp.egress, maxOut: t.budget.maxOut });

    for (let round = 0; round < 4; round++) {
      if (run.state === "AWAITING_PLAN_APPROVAL") {
        if (!existsSync(planFile)) {
          run.beginCall(0);
          const plan = await architect(roleCtx(providers.architect!), { goal: t.contract.goal, acceptance: t.contract.acceptance, context: ctxText() });
          run.endCall();
          const text = JSON.stringify(plan, null, 2);
          writeFileSync(planFile, JSON.stringify({ text, hash: sha256(text) }));
          env.out(`Plan written (hash ${sha256(text).slice(0, 12)}). Review and approve from an interactive terminal: agentic task approve ${id}`);
        } else env.out(`Awaiting plan approval: agentic task approve ${id}`);
        break;
      }
      if (run.state === "IMPLEMENTING" || run.state === "BOUNDED_REPAIR") {
        if (!usesModel) {
          const o = await run.recipe(t.contract.recipe!);
          if (!o.ok && run.state === "BOUNDED_REPAIR") run.stop("ESCALATED", "unsupported capability: recipe failed and R0 has no model route");
          break;
        }
        const plan = existsSync(planFile) ? (JSON.parse(readFileSync(planFile, "utf8")).text as string) : undefined;
        await drive(run, providers.worker!, t.candidate, { goal: t.contract.goal, acceptance: t.contract.acceptance, files: t.contract.files, ...(plan ? { plan } : {}) }, t.budget.limits.toolActions, t.budget.maxOut, t.budget.maxContext);
        continue;
      }
      if (run.state === "REVIEWING") {
        run.beginCall(0);
        const findings = await review(roleCtx(providers.reviewer!), { goal: t.contract.goal, acceptance: t.contract.acceptance, changed: run.changed(), gates: run.evidence?.gates ?? [] });
        run.endCall();
        run.completeReview(findings);
        continue;
      }
      break;
    }
    if (run.uncertainBilling) env.out("Note: a billable call was in flight at the last crash; it is charged at its reservation and flagged uncertain.");
    env.out(JSON.stringify({ task: id, state: run.state, tier: t.tier, tokens: run.ledger.tokens, costUsd: run.ledger.costUsd, unknownUsageCalls: run.ledger.unknownUsageCalls }));
    return EXIT[run.state] ?? 1;
  } catch (e) {
    if (e instanceof RoleFailed) {
      run.stop("BLOCKED", `${e.reason}: ${e.message}`);
      env.out(`blocked: ${e.reason}: ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    run.close();
  }
}

function requireOperator(env: Env, what: string) {
  // Human decisions are never taken from flags or env vars: they need a person at a terminal.
  if (!env.operatorTty) throw new CliError(`${what} is an operator decision: run it from an interactive terminal`, 3);
}

async function withRun<T>(env: Env, id: string, fn: (run: Run, t: ReturnType<typeof load>) => Promise<T> | T): Promise<T> {
  const t = load(env, id);
  const iso = loadChoice(t.stateDir);
  if (!iso) throw new CliError("task has not been run yet");
  const run = new Run(t.policy(iso));
  try {
    run.resume();
    return await fn(run, t);
  } finally {
    run.close();
  }
}

export async function taskApprove(env: Env, id: string): Promise<number> {
  requireOperator(env, "plan approval");
  return withRun(env, id, async (run, t) => {
    if (run.state !== "AWAITING_PLAN_APPROVAL") throw new CliError(`task is ${run.state}, not awaiting plan approval`);
    const f = join(t.dir, "plan.json");
    if (!existsSync(f)) throw new CliError("no plan has been written yet: run the task first");
    const { text, hash } = JSON.parse(readFileSync(f, "utf8"));
    if (sha256(text) !== hash) throw new CliError("plan file was modified after it was written");
    env.out(`${text}\n\nplan hash: ${hash}`);
    const a = (await env.ask("Approve this exact plan? (yes/no): ")).trim().toLowerCase();
    if (a !== "yes") { env.out("not approved"); return 1; }
    run.approvePlan(`operator:${env.user}`, text);
    env.out("plan approved; continue with: agentic task run " + id);
    return 0;
  });
}

export async function taskAccept(env: Env, id: string): Promise<number> {
  requireOperator(env, "acceptance");
  return withRun(env, id, async (run) => {
    if (run.state !== "AWAITING_ACCEPTANCE" || !run.evidence) throw new CliError(`task is ${run.state}, nothing to accept`);
    const e = run.evidence;
    env.out(`tier ${e.tier} · candidate ${e.candidate.slice(0, 12)} · isolation ${e.isolation}\ngates: ${e.gates.map((g) => `${g.gateId}=${g.status}`).join(", ")}\nfindings: ${e.findings?.length ?? 0}\nlimitations: ${e.limitations.join("; ") || "none"}`);
    const a = (await env.ask("Accept this exact candidate? (yes/no): ")).trim().toLowerCase();
    if (a !== "yes") { env.out("not accepted"); return 1; }
    run.accept(`operator:${env.user}`);
    env.out("accepted (not merged, not deployed). Export a patch: agentic task export " + id);
    return 0;
  });
}

export async function taskCancel(env: Env, id: string): Promise<number> {
  return withRun(env, id, (run) => {
    run.cancel();
    env.out("cancelled");
    return 0;
  });
}

export async function taskStatus(env: Env, id: string): Promise<number> {
  load(env, id);
  env.out(JSON.stringify(statusOf(env, id)));
  return 0;
}

export async function report(env: Env, id: string): Promise<number> {
  return withRun(env, id, (run) => {
    env.out(JSON.stringify({ state: run.state, ledger: run.ledger.snapshot(), uncertainBilling: run.uncertainBilling, evidence: run.evidence ?? null }, null, 2));
    return 0;
  });
}

// Unified diff of the candidate against the start of the run (text files). Applies with `git apply`.
export async function exportPatch(env: Env, id: string): Promise<number> {
  return withRun(env, id, (run, t) => {
    const scratch = mkdtempSync(join(tmpdir(), "export-"));
    let patch = "";
    const skipped: string[] = [];
    for (const c of run.changed()) {
      const a = join(scratch, "a"), b = join(scratch, "b");
      writeFileSync(a, c.before ?? "");
      writeFileSync(b, c.after ?? "");
      const r = spawnSync("diff", ["-u", ...(c.before === null ? ["--new-file"] : []), "--label", c.before === null ? "/dev/null" : `a/${c.path}`, "--label", c.after === null ? "/dev/null" : `b/${c.path}`, a, b], { encoding: "utf8" });
      if (r.status === 1) patch += `diff --git a/${c.path} b/${c.path}\n${c.before === null ? "new file mode 100644\n" : c.after === null ? "deleted file mode 100644\n" : ""}${r.stdout}`;
      else if (r.status !== 0) skipped.push(c.path);
    }
    const out = join(t.dir, "changes.patch");
    writeFileSync(out, patch);
    env.out(`wrote ${out}${skipped.length ? ` (skipped, not text: ${skipped.join(", ")})` : ""}\napply with: git apply ${out}  (state: ${run.state}${run.state === "ACCEPTED" ? "" : " — NOT accepted"})`);
    return 0;
  });
}

// Records a qualification for a configured profile. The probe spends tokens on that profile.
export async function qualify(env: Env, profileName: string, ownerDeclare?: "architecture" | "review" | "action-protocol"): Promise<number> {
  const mf = projectFile(env, "models.json");
  const models = loadValidated<Models>(mf, "models");
  const provider = makeProvider(env, profileName, models);
  const store = new QualStore(join(env.home, "qualifications.json"));
  if (ownerDeclare) {
    requireOperator(env, "an owner-declared qualification");
    const a = (await env.ask(`Declare ${provider.id} qualified for "${ownerDeclare}" without a measured eval? (yes/no): `)).trim().toLowerCase();
    if (a !== "yes") return 1;
    store.record({ profileId: provider.id, family: ownerDeclare, source: "owner-declared", passed: true, detail: { declaredBy: env.user }, at: new Date().toISOString() });
    env.out(`recorded owner-declared ${ownerDeclare} for ${provider.id}`);
    return 0;
  }
  if (provider.hosted && loadValidated<ProjectPolicy>(projectFile(env, "policy.json"), "policy").egress !== "hosted-allowed") {
    throw new CliError(`${provider.id} is hosted but the policy egress is local-only`);
  }
  const { probeActionProtocol } = await import("../qualify.ts");
  const q = await probeActionProtocol(provider, store);
  env.out(`${provider.id} action-protocol: ${q.passed ? "PASSED" : "FAILED"} ${JSON.stringify(q.detail)}`);
  return q.passed ? 0 : 1;
}
