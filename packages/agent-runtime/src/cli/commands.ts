import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetExceeded, type Limits } from "../budget.ts";
import { ChatCompletionsProvider } from "../chat.ts";
import { ClaudeCliProvider } from "../claude.ts";
import { compile, render } from "../context.ts";
import { drive } from "../drive.ts";
import { EventLog } from "../events.ts";
import { canonical, sha256 } from "../hash.ts";
import { ManualProvider } from "../manual.ts";
import { OllamaProvider } from "../ollama.ts";
import { type GenerationProvider, MockProvider } from "../provider.ts";
import { prSummary, readSessions, sessionCheck, updatePr } from "../session.ts";
import { needsStrongWorker, QualStore, selectProfile } from "../qualify.ts";
import { maxTier, riskFloor } from "../risk.ts";
import { architect, review, RoleFailed } from "../roles.ts";
import { runGate } from "../gates.ts";
import { type Policy, Run, type RiskTier, snapshot } from "../run.ts";
import { type ArchConfig, ArchUnavailable, checkArchitecture, formatReport } from "../arch/check.ts";
import { validate } from "../schema.ts";
import { JevClient, type DecisionTransport } from "../jev/client.ts";
import { calibrate } from "../jev/calibrate.ts";
import {
  type Family,
  Fabric,
  type Item,
  loadCalibrations,
  type Mode,
  readTelemetry,
  saveCalibrations,
} from "../jev/fabric.ts";
import { readdirSync } from "node:fs";
import * as learn from "../learning/store.ts";
import { allTasks, formatStats, summarizeTasks } from "../stats.ts";
import { activeLessons, type Lesson } from "../learning/store.ts";

export type Env = {
  home: string; // controller state (tasks, qualifications): outside every project
  project: string;
  out: (s: string) => void;

  user: string;
  secrets?: Record<string, string>; // loaded by main from $AGENTIC_HOME/secrets.env; never passed to workers
  jevTransport?: DecisionTransport; // tests inject a fake
  lessons?: Lesson[]; // evaluation only: replaces the active release for this process
  evalsRoot?: string; // where evals/ lives (holdout material is checked against it)
  wrapProvider?: (provider: GenerationProvider) => GenerationProvider; // shared evaluation accounting
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
  standard: {
    limits: { aggregateTokens: 40_000, toolActions: 12, semanticRepairs: 1 },
    maxContext: 8000,
    maxOut: 3000,
  },
  complex: {
    limits: { aggregateTokens: 100_000, toolActions: 24, semanticRepairs: 1 },
    maxContext: 16000,
    maxOut: 6000,
  },
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
  id: string;
  goal: string;
  acceptance: string[];
  files: string[];
  newFiles?: string[];
  scope?: string[];
  riskTier: RiskTier;
  riskTags?: string[];
  family?: string;
  budget: "narrow" | "standard" | "complex";
  recipe?: { path: string; find: string; replace: string };
  unresolvedQuestions?: string[];
};
type ProjectPolicy = {
  enabled?: boolean; // the managed-workflow switch; absent = on
  protectedPaths: string[];
  protectExistingTests?: boolean;
  gates: Policy["gates"];
  requiredGates: string[];
  egress: Policy["egress"];
  bootstrap?: { argv: string[]; timeoutMs: number; env?: Record<string, string> };
  baseline?: "require-pass" | "record" | "off";
  jev?: {
    auto?: boolean;
    modes?: Partial<Record<Family, Mode>>;
    allowSource?: boolean;
    model?: string;
    pinnedModel?: string;
    timeoutMs?: number;
    allowUncalibrated?: boolean;
  };
};
type Models = {
  profiles: Record<string, Record<string, any>>;
  roles: { worker: string; workerStrong?: string; architect?: string; reviewer?: string };
};

// Copies what git considers part of the project (tracked + untracked, minus ignored): no build output, no .env.
// Without git it falls back to excluding the usual heavy directories.
function copyProject(src: string, dest: string): void {
  const r = spawnSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], {
    cwd: src,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    cpSync(src, dest, {
      recursive: true,
      filter: (p) => !/(^|\/)(\.git|node_modules|\.next|dist|build|\.agentic)(\/|$)/.test(p.slice(src.length)),
    });
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
    if (st.isSymbolicLink())
      symlinkSync(readlinkSync(from), to); // links stay links, never followed
    else if (st.isFile()) copyFileSync(from, to);
    // anything else (gitlinks/submodule dirs, sockets) is not project content we copy
  }
}

const taskDir = (env: Env, id: string) => join(env.home, "tasks", id);
const stateOf = (env: Env, id: string) => join(taskDir(env, id), "state");
const projectFile = (env: Env, ...p: string[]) => join(env.project, ".agents", ...p);

function makeProvider(name: string, models: Models): GenerationProvider {
  const p = models.profiles[name];
  if (!p) throw new CliError(`profile not defined: ${name}`);
  switch (p.kind) {
    case "claude-cli":
      return new ClaudeCliProvider({
        model: p.model,
        maxBudgetUsd: p.maxBudgetUsd ?? 0.05,
        timeoutMs: p.timeoutMs ?? 120_000,
      });
    case "ollama":
      return new OllamaProvider({
        baseUrl: p.baseUrl,
        model: p.model,
        numCtx: p.numCtx ?? 4096,
        temperature: 0,
        timeoutMs: p.timeoutMs ?? 120_000,
      });
    case "chat-completions":
      return new ChatCompletionsProvider({
        baseUrl: p.baseUrl,
        model: p.model,
        hosted: p.hosted,
        apiKeyEnv: p.apiKeyEnv,
        supportsJsonSchema: p.supportsJsonSchema ?? false,
        temperature: 0,
        timeoutMs: p.timeoutMs ?? 120_000,
      });
    case "manual":
      return new ManualProvider(p.dir, p.label, p.timeoutMs);
    case "replay":
      return Object.assign(new MockProvider(JSON.parse(readFileSync(p.file, "utf8"))), {
        id: `mock/replay:${basename(p.file)}`,
      });
  }
  throw new CliError(`unsupported profile kind: ${p.kind}`);
}

// ---------------- Jev decision fabric (optional) ----------------

const telemetryFile = (env: Env) => join(env.home, "telemetry", "jev.jsonl");
const calibrationFile = (env: Env) => join(env.home, "calibration.json");

// Optional paid experiments require explicit project opt-in. A credential alone makes no calls.
export function effectiveJev(env: Env, pp: ProjectPolicy): { modes: Partial<Record<Family, Mode>>; why: string } {
  const j = pp.jev;
  if (j?.modes && Object.keys(j.modes).length) return { modes: j.modes, why: "modes set in .agents/policy.json" };
  if (j?.auto !== true) return { modes: {}, why: "Jev is opt-in (set jev.auto true or explicit modes)" };
  if (!env.secrets?.JEV_API_KEY) return { modes: {}, why: "no JEV_API_KEY in the user-level secrets store" };
  return { modes: { "workflow-select": "enabled" }, why: "opt-in: jev.auto true and key present" };
}

function makeFabric(env: Env, pp: ProjectPolicy): Fabric | undefined {
  const j = pp.jev;
  const { modes } = effectiveJev(env, pp);
  if (Object.values(modes).every((m) => !m || m === "disabled")) return undefined; // off unless configured or auto
  const transport =
    env.jevTransport ??
    new JevClient({
      apiKey: env.secrets?.JEV_API_KEY,
      ...(j?.model ? { model: j.model } : {}),
      ...(j?.timeoutMs ? { timeoutMs: j.timeoutMs } : {}),
    });
  return new Fabric({
    transport,
    telemetryFile: telemetryFile(env),
    calibrations: loadCalibrations(calibrationFile(env)),
    policy: {
      egress: pp.egress,
      allowSource: j?.allowSource ?? false,
      ...(j?.allowUncalibrated ? { allowUncalibrated: true } : {}),
      modes,
      ...(j?.pinnedModel ? { pinnedModel: j.pinnedModel } : {}),
    },
  });
}

const skillsOf = (root: string): Array<{ name: string; description: string }> => {
  const dir = join(root, ".agents", "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = join(dir, e.name, "SKILL.md");
    const m = existsSync(f) ? /^description:\s*(.+)$/m.exec(readFileSync(f, "utf8")) : null;
    return e.isDirectory() && m ? [{ name: e.name, description: m[1]!.slice(0, 300) }] : [];
  });
};

// Decisions are minimized: the goal, acceptance and metadata, never source (except the retrieval family, which
// needs allowSource). In shadow mode nothing here changes what the run does. Returns "ask" only when an
// ENABLED, calibrated workflow decision says the request cannot be implemented from the information given.
async function jevDecisions(
  env: Env,
  t: ReturnType<typeof load>,
  taskId: string,
  fabric: Fabric,
): Promise<"ask" | undefined> {
  const state = `GOAL: ${t.contract.goal}\nACCEPTANCE:\n${t.contract.acceptance.map((a) => `- ${a}`).join("\n")}\nFILES: ${t.contract.files.join(", ")}\nRISK TIER: ${t.tier}`;
  let ask: "ask" | undefined;
  if (t.tier !== "R3" && !(t.tier === "R0" && t.contract.recipe)) {
    // rules already determine R0 recipes and R3 blocks
    const route: Item = {
      id: "route",
      rulesDefault: "standard-worker",
      instructions:
        "Decide how to route this software task. Choose standard-worker if a developer could implement and verify it from the goal, acceptance criteria and listed files alone. Choose ask-clarification if it depends on information that is not provided (a referenced document, a decision) or its requirements contradict each other or established facts.",
      options: {
        "standard-worker": "Implementable and verifiable from the information given.",
        "ask-clarification":
          "Needs missing information or has contradictory requirements; a person must clarify first.",
      },
    };
    const [r] = await fabric.decide("workflow-select", { taskId, state, items: [route] });
    if (r?.source === "jev" && r.chosen === "ask-clarification") ask = "ask";
  }
  const skills = skillsOf(env.project).slice(0, 12);
  if (skills.length >= 2) {
    await fabric.decide("skill-select", {
      taskId,
      state,
      items: skills.map((s) => ({
        id: `skill:${s.name}`,
        rulesDefault: "not_needed",
        instructions: `Is the workflow skill "${s.name}" (${s.description}) needed to do this task well?`,
        options: { needed: "Load this skill for the task.", not_needed: "Not needed for this task." },
      })),
    });
  }
  if (fabric.mode("retrieval-rerank") !== "disabled") {
    const p = compile(t.candidate, t.contract.files, t.budget.maxContext);
    const items: Item[] = p.omitted.slice(0, 12).map((o) => ({
      id: `file:${o.path}`,
      rulesDefault: "skip",
      instructions: `Is the file ${o.path} needed to implement the task?`,
      options: { include: "Include this file in the worker's context.", skip: "Not needed." },
    }));
    if (items.length) {
      const heads = p.omitted
        .slice(0, 12)
        .map((o) => `--- ${o.path}\n${readFileSync(join(t.candidate, o.path), "utf8").slice(0, 400)}`)
        .join("\n");
      await fabric.decide("retrieval-rerank", {
        taskId,
        state: `${state}\nCANDIDATE FILES (excerpts):\n${heads}`,
        items,
      });
    }
  }
  return ask;
}

// ---------------- commands ----------------

export async function doctor(env: Env): Promise<number> {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  const rows: Array<[string, string]> = [
    [
      "node",
      maj > 22 || (maj === 22 && min >= 18)
        ? `ok ${process.versions.node}`
        : `FAIL ${process.versions.node} (need ≥22.18)`,
    ],
    ["git", spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0 ? "ok" : "missing"],
  ];
  rows.push([
    "workflow",
    existsSync(projectFile(env, "policy.json"))
      ? workflowEnabled(env)
        ? "ON (default): tasks are verified by the controller"
        : "OFF: nothing model-driven runs; enable with `agentic enable`"
      : "not installed in this project",
  ]);
  for (const [file, schema] of [
    ["policy.json", "policy"],
    ["models.json", "models"],
  ] as const) {
    const f = projectFile(env, file);
    if (!existsSync(f)) {
      rows.push([file, "absent"]);
      continue;
    }
    try {
      loadValidated(f, schema);
      rows.push([file, "valid"]);
    } catch (e) {
      rows.push([file, `INVALID ${(e as Error).message.split("\n")[1]?.trim() ?? ""}`]);
    }
  }
  if (existsSync(projectFile(env, "policy.json"))) {
    try {
      const pp = loadValidated<ProjectPolicy>(projectFile(env, "policy.json"), "policy");
      const { modes, why } = effectiveJev(env, pp);
      const active = Object.entries(modes)
        .filter(([, m]) => m && m !== "disabled")
        .map(([f, m]) => `${f}=${m}`);
      rows.push([
        "jev",
        !active.length
          ? `off (${why})`
          : pp.egress !== "hosted-allowed"
            ? `key/config present but NOT used: policy egress is local-only (set "egress": "hosted-allowed" to allow sending the task goal and file names)`
            : `on (${why}): ${active.join(", ")}`,
      ]);
    } catch {
      /* an invalid policy is reported above */
    }
  }
  rows.push([
    "qualifications",
    `${new QualStore(join(env.home, "qualifications.json")).all().filter((q) => q.passed).length} passed`,
  ]);
  for (const [k, v] of rows) env.out(`${k.padEnd(20)} ${v}`);
  return rows.some(([, v]) => v.startsWith("FAIL") || v.startsWith("INVALID")) ? 1 : 0;
}

export async function validateFiles(env: Env, contracts: string[]): Promise<number> {
  let bad = 0;
  const check = (f: string, s: string) => {
    try {
      loadValidated(f, s);
      env.out(`ok       ${f}`);
    } catch (e) {
      bad += 1;
      env.out(`INVALID  ${(e as Error).message}`);
    }
  };
  if (existsSync(projectFile(env, "policy.json"))) check(projectFile(env, "policy.json"), "policy");
  if (existsSync(projectFile(env, "models.json"))) check(projectFile(env, "models.json"), "models");
  if (existsSync(projectFile(env, "architecture.json"))) check(projectFile(env, "architecture.json"), "architecture");
  for (const c of contracts) check(c, "task-contract");
  return bad ? 1 : 0;
}

export async function taskCreate(env: Env, file: string): Promise<number> {
  const c = loadValidated<Contract>(file, "task-contract");
  const dir = taskDir(env, c.id);
  if (existsSync(dir)) throw new CliError(`task already exists: ${c.id}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "contract.json"), JSON.stringify(c, null, 2));
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ project: env.project, createdAt: new Date().toISOString() }, null, 2),
  );
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
  const scopeFloor = riskFloor({
    paths: contract.scope ?? [...contract.files, ...(contract.newFiles ?? [])],
    tags: contract.riskTags,
    recipe: !!contract.recipe,
  });
  const tier = maxTier(contract.riskTier, scopeFloor);
  const base = { contract, pp, models, budget, dir, candidate, stateDir, tier };
  const policy = (): Policy => ({
    workspace: candidate,
    stateDir,
    protectedPaths: pp.protectedPaths,
    writePaths: contract.scope ?? [...contract.files, ...(contract.newFiles ?? [])],
    protectExistingTests: pp.protectExistingTests ?? true,
    gates: pp.gates,
    requiredGates: pp.requiredGates,
    limits: budget.limits,
    egress: pp.egress,
    riskTier: tier,
    ...(contract.riskTags?.length ? { riskTags: contract.riskTags } : {}),
    baseline: pp.baseline ?? "require-pass", // a candidate is only judged against a green starting point
    ...(pp.bootstrap
      ? {
          bootstrap: {
            id: "bootstrap",
            argv: pp.bootstrap.argv,
            timeoutMs: pp.bootstrap.timeoutMs,
            discover: { regex: "", min: 0 },
            ...(pp.bootstrap.env ? { env: pp.bootstrap.env } : {}),
          },
        }
      : {}),
  });
  return { ...base, policy };
}

export function statusOf(env: Env, id: string) {
  const events = new EventLog(join(stateOf(env, id), "events.jsonl")).read();
  const last = [...events].reverse().find((e) => e.type === "state");
  const ledger = [...events]
    .reverse()
    .map((e) => (e.data as any)?.ledger ?? (e.type === "ledger" ? e.data : undefined))
    .find(Boolean);
  return {
    state: (last?.data as any)?.to ?? "NOT_STARTED",
    why: (last?.data as any)?.why,
    events: events.length,
    ledger,
  };
}

const EXIT: Record<string, number> = { AWAITING_ACCEPTANCE: 0, ACCEPTED: 0, NEEDS_INPUT: 2, AWAITING_PLAN_APPROVAL: 2 };

// The managed-workflow switch lives in .agents/policy.json ("enabled", default on). Off = nothing model-driven runs.
export const workflowEnabled = (env: Env): boolean => {
  const f = projectFile(env, "policy.json");
  return !existsSync(f) || loadValidated<ProjectPolicy>(f, "policy").enabled !== false;
};

export async function taskRun(env: Env, id: string): Promise<number> {
  if (!workflowEnabled(env)) {
    env.out(
      "The managed workflow is turned off (.agents/policy.json: enabled false). Nothing was run. Turn it on: node scripts/agentic.mjs enable",
    );
    return 2;
  }
  const t = load(env, id);
  if (t.contract.unresolvedQuestions?.length)
    throw new CliError(`unresolved design decision: ${t.contract.unresolvedQuestions.join("; ")}`);
  const fresh = !existsSync(join(t.stateDir, "events.jsonl"));

  // Providers and qualifications are checked before any state is created: a task we cannot route has no side effects.
  const store = new QualStore(join(env.home, "qualifications.json"));
  const usesModel = !(t.tier === "R0" && t.contract.recipe);
  const providerFor = (name: string, models: Models) => {
    const p = makeProvider(name, models);
    return env.wrapProvider ? env.wrapProvider(p) : p;
  };
  const providers: {
    worker?: GenerationProvider;
    workerStrong?: GenerationProvider;
    architect?: GenerationProvider;
    reviewer?: GenerationProvider;
  } = {};
  if (usesModel) {
    const models = t.models();
    if (!models)
      throw new CliError("no .agents/models.json: configure a worker profile (see schemas/models.schema.json)");
    const wanted: Array<["worker" | "architect" | "reviewer", boolean]> = [
      ["worker", true],
      ["architect", t.tier === "R2" || t.tier === "R3"],
      ["reviewer", t.tier === "R2" || t.tier === "R3"],
    ];
    for (const [role, needed] of wanted) {
      if (!needed) continue;
      const name = models.roles[role];
      if (!name) throw new CliError(`no ${role} profile configured for a ${t.tier} task`);
      const sel = selectProfile(role, t.tier, [providerFor(name, models)], store);
      if (!sel.ok) throw new CliError(`${sel.reason} (profile "${name}"). Qualify it first: agentic qualify ${name}`);
      providers[role] = sel.provider;
    }
    if (models.roles.workerStrong) {
      const sel = selectProfile("worker", t.tier, [providerFor(models.roles.workerStrong, models)], store);
      if (!sel.ok)
        throw new CliError(
          `${sel.reason} (profile "${models.roles.workerStrong}"). Qualify it first: agentic qualify ${models.roles.workerStrong}`,
        );
      providers.workerStrong = sel.provider;
    }
  }

  if (fresh) {
    rmSync(t.candidate, { recursive: true, force: true }); // a crashed earlier copy must not leak into this one
    copyProject(env.project, t.candidate);
  }
  const run = new Run(t.policy());
  env.onRun?.(run);
  const executionStarted = performance.now();
  try {
    run.record("execution_started", {});
    // Lessons are pinned per task at its first start: later promotions never change a run midway.
    const pinFile = join(t.dir, "lessons-pin.json");
    if (fresh) {
      const a = env.lessons
        ? { releaseId: "eval-override", lessons: env.lessons }
        : activeLessons(env.home, { ...(t.contract.family ? { family: t.contract.family } : {}), maxTokens: 300 });
      writeFileSync(
        pinFile,
        JSON.stringify({ releaseId: a.releaseId, lessons: a.lessons.map((l) => ({ id: l.id, text: l.text })) }),
      );
    }
    const pinned: Array<{ id: string; text: string }> = existsSync(pinFile)
      ? JSON.parse(readFileSync(pinFile, "utf8")).lessons
      : [];
    if (fresh) {
      await run.prepare();
      run.start();
      if (pinned.length)
        run.record("lessons_pinned", {
          release: JSON.parse(readFileSync(pinFile, "utf8")).releaseId,
          ids: pinned.map((l) => l.id),
        });
      const fabric = makeFabric(env, t.pp);
      if (fabric && run.state === "IMPLEMENTING" && (await jevDecisions(env, t, id, fabric)) === "ask") {
        run.stop("NEEDS_INPUT", "jev (enabled): the request needs clarification before any model call");
      }
    } else run.resume();
    if (run.state === "VERIFYING") await run.reverify();
    const planFile = join(t.dir, "plan.json");
    const ctxText = () =>
      render(
        compile(t.candidate, [...new Set([...t.contract.files, ...(t.contract.newFiles ?? [])])], t.budget.maxContext, {
          allowMissing: t.contract.newFiles,
        }),
      );
    const roleCtx = (p: GenerationProvider) => ({
      provider: p,
      ledger: run.ledger,
      egress: t.pp.egress,
      maxOut: t.budget.maxOut,
      beginCall: (reserved: number) => run.beginCall(reserved, p.hosted),
      endCall: () => run.endCall(),
      signal: run.signal,
    });

    const routes: string[] = []; // worker profile per drive, so outcomes can be compared per route
    for (let round = 0; round < 4; round++) {
      if (run.state === "AWAITING_PLAN_APPROVAL") {
        if (!existsSync(planFile)) {
          const plan = await architect(roleCtx(providers.architect!), {
            goal: t.contract.goal,
            acceptance: t.contract.acceptance,
            context: ctxText(),
          });
          const text = JSON.stringify(plan, null, 2);
          writeFileSync(planFile, JSON.stringify({ text, hash: sha256(text) }));
          env.out(`Plan written (hash ${sha256(text).slice(0, 12)}). Review and approve: agentic task approve ${id}`);
        } else env.out(`Awaiting plan approval: agentic task approve ${id}`);
        break;
      }
      if (run.state === "IMPLEMENTING" || run.state === "BOUNDED_REPAIR") {
        if (!usesModel) {
          const o = await run.recipe(t.contract.recipe!);
          if (!o.ok && run.state === "BOUNDED_REPAIR")
            run.stop("ESCALATED", "unsupported capability: recipe failed and R0 has no model route");
          break;
        }
        const plan = existsSync(planFile) ? (JSON.parse(readFileSync(planFile, "utf8")).text as string) : undefined;
        const strong = providers.workerStrong && needsStrongWorker(t.tier, t.contract.files.length, run.ledger.repairs);
        const worker = strong ? providers.workerStrong! : providers.worker!;
        routes.push(worker.id);
        await drive(
          run,
          worker,
          t.candidate,
          {
            goal: t.contract.goal,
            acceptance: t.contract.acceptance,
            files: t.contract.files,
            newFiles: t.contract.newFiles,
            writePaths: t.policy().writePaths,
            ...(plan ? { plan } : {}),
            ...(pinned.length ? { lessons: pinned.map((l) => l.text) } : {}),
          },
          t.budget.limits.toolActions,
          t.budget.maxOut,
          t.budget.maxContext,
          true,
        );
        continue;
      }
      if (run.state === "REVIEWING") {
        const findings = await review(roleCtx(providers.reviewer!), {
          goal: t.contract.goal,
          acceptance: t.contract.acceptance,
          changed: run.changed(),
          gates: run.draftGates,
        });
        run.completeReview(findings);
        continue;
      }
      break;
    }
    if (run.uncertainBilling)
      env.out(
        "Note: a billable call was in flight at the last crash; it is charged at its reservation and flagged uncertain.",
      );
    env.out(
      JSON.stringify({
        task: id,
        state: run.state,
        tier: t.tier,
        ...(routes.length ? { workers: routes } : {}),
        tokens: run.ledger.tokens,
        costUsd: run.ledger.costUsd,
        unknownUsageCalls: run.ledger.unknownUsageCalls,
        unknownCostCalls: run.ledger.unknownCostCalls,
      }),
    );
    return EXIT[run.state] ?? 1;
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      run.stop("ESCALATED", `budget exhausted: ${e.message}`);
      env.out(`budget exhausted: ${e.message}`);
      return 1;
    }
    if (e instanceof RoleFailed) {
      run.stop("BLOCKED", `${e.reason}: ${e.message}`);
      env.out(`blocked: ${e.reason}: ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    try {
      run.record("execution_finished", { durationMs: performance.now() - executionStarted });
    } finally {
      run.close();
    }
  }
}

async function withRun<T>(
  env: Env,
  id: string,
  fn: (run: Run, t: ReturnType<typeof load>) => Promise<T> | T,
): Promise<T> {
  const t = load(env, id);
  if (!existsSync(join(t.stateDir, "events.jsonl"))) throw new CliError("task has not been run yet");
  const run = new Run(t.policy());
  try {
    run.resume();
    return await fn(run, t);
  } finally {
    run.close();
  }
}

export async function taskApprove(env: Env, id: string): Promise<number> {
  return withRun(env, id, async (run, t) => {
    if (run.state !== "AWAITING_PLAN_APPROVAL") throw new CliError(`task is ${run.state}, not awaiting plan approval`);
    const f = join(t.dir, "plan.json");
    if (!existsSync(f)) throw new CliError("no plan has been written yet: run the task first");
    const { text, hash } = JSON.parse(readFileSync(f, "utf8"));
    if (sha256(text) !== hash) throw new CliError("plan file was modified after it was written");
    env.out(`${text}\n\nplan hash: ${hash}`);
    run.approvePlan(`operator:${env.user}`, text);
    env.out("plan approved; continue with: agentic task run " + id);
    return 0;
  });
}

export async function taskAccept(env: Env, id: string): Promise<number> {
  return withRun(env, id, async (run) => {
    if (run.state !== "AWAITING_ACCEPTANCE" || !run.evidence)
      throw new CliError(`task is ${run.state}, nothing to accept`);
    const e = run.evidence;
    env.out(
      `tier ${e.tier} · candidate ${e.candidate.slice(0, 12)}\ngates: ${e.gates.map((g) => `${g.gateId}=${g.status}`).join(", ")}\nfindings: ${e.findings?.length ?? 0}\nlimitations: ${e.limitations.join("; ") || "none"}`,
    );
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
    env.out(
      JSON.stringify(
        {
          state: run.state,
          ledger: run.ledger.snapshot(),
          uncertainBilling: run.uncertainBilling,
          evidence: run.evidence ?? null,
        },
        null,
        2,
      ),
    );
    return 0;
  });
}

// Independent re-check of a finished task: same candidate bytes, same policy, gates run again from scratch.
// Read-only: it never changes the task's state. Exit 0 only if everything still holds.
export async function verifyTask(env: Env, id: string): Promise<number> {
  return withRun(env, id, async (run, t) => {
    const e = run.evidence;
    if (!e) throw new CliError(`no evidence to verify: task is ${run.state}`);
    const problems: string[] = [];
    if (snapshot(t.candidate) !== e.candidate) problems.push("candidate changed since it was verified");
    if (sha256(canonical(t.policy())) !== e.policyHash) problems.push("policy changed since it was verified");
    for (const gateId of t.pp.requiredGates) {
      const spec = t.pp.gates.find((g) => g.id === gateId)!;
      const r = await runGate(spec, t.candidate, snapshot(t.candidate));
      env.out(`gate ${gateId}: ${r.status}${r.discovered !== null ? ` (${r.discovered} discovered)` : ""}`);
      if (r.status !== "pass") problems.push(`gate ${gateId} is ${r.status}`);
    }
    env.out(
      problems.length
        ? `NOT VERIFIED: ${problems.join("; ")}`
        : `verified: candidate ${e.candidate.slice(0, 12)} passes ${t.pp.requiredGates.join(", ")}`,
    );
    return problems.length ? 1 : 0;
  });
}

// Unified diff of the candidate against the start of the run (text files). Applies with `git apply`.
export async function exportPatch(env: Env, id: string): Promise<number> {
  return withRun(env, id, (run, t) => {
    const scratch = mkdtempSync(join(tmpdir(), "export-"));
    let patch = "";
    const skipped: string[] = [];
    for (const c of run.changed()) {
      const a = join(scratch, "a"),
        b = join(scratch, "b");
      writeFileSync(a, c.before ?? "");
      writeFileSync(b, c.after ?? "");
      const r = spawnSync(
        "diff",
        [
          "-u",
          ...(c.before === null ? ["--new-file"] : []),
          "--label",
          c.before === null ? "/dev/null" : `a/${c.path}`,
          "--label",
          c.after === null ? "/dev/null" : `b/${c.path}`,
          a,
          b,
        ],
        { encoding: "utf8" },
      );
      if (r.status === 1)
        patch += `diff --git a/${c.path} b/${c.path}\n${c.before === null ? "new file mode 100644\n" : c.after === null ? "deleted file mode 100644\n" : ""}${r.stdout}`;
      else if (r.status !== 0) skipped.push(c.path);
    }
    const out = join(t.dir, "changes.patch");
    writeFileSync(out, patch);
    env.out(
      `wrote ${out}${skipped.length ? ` (skipped, not text: ${skipped.join(", ")})` : ""}\napply with: git apply ${out}  (state: ${run.state}${run.state === "ACCEPTED" ? "" : " — NOT accepted"})`,
    );
    return 0;
  });
}

// Records a qualification for a configured profile. The probe spends tokens on that profile.
export async function qualify(
  env: Env,
  profileName: string,
  ownerDeclare?: "architecture" | "review" | "action-protocol",
): Promise<number> {
  if (!ownerDeclare && !workflowEnabled(env))
    throw new CliError(
      "the managed workflow is turned off (.agents/policy.json: enabled false); probes spend money, so they are not run",
    );
  const mf = projectFile(env, "models.json");
  const models = loadValidated<Models>(mf, "models");
  const provider = makeProvider(profileName, models);
  const store = new QualStore(join(env.home, "qualifications.json"));
  if (ownerDeclare) {
    store.record({
      profileId: provider.id,
      family: ownerDeclare,
      source: "owner-declared",
      passed: true,
      detail: { declaredBy: env.user },
      at: new Date().toISOString(),
    });
    env.out(`recorded owner-declared ${ownerDeclare} for ${provider.id}`);
    return 0;
  }
  if (
    provider.hosted &&
    loadValidated<ProjectPolicy>(projectFile(env, "policy.json"), "policy").egress !== "hosted-allowed"
  ) {
    throw new CliError(`${provider.id} is hosted but the policy egress is local-only`);
  }
  const { probeActionProtocol } = await import("../qualify.ts");
  const q = await probeActionProtocol(provider, store);
  env.out(`${provider.id} action-protocol: ${q.passed ? "PASSED" : "FAILED"} ${JSON.stringify(q.detail)}`);
  return q.passed ? 0 : 1;
}

export async function jevStatus(env: Env): Promise<number> {
  const pp = loadValidated<ProjectPolicy>(projectFile(env, "policy.json"), "policy");
  const j = pp.jev;
  env.out(
    `credential: ${env.secrets?.JEV_API_KEY ? "present (user-level store)" : "absent"}   egress: ${pp.egress}   allowSource: ${j?.allowSource ?? false}`,
  );
  for (const f of ["workflow-select", "skill-select", "retrieval-rerank"] as const) {
    const cal = loadCalibrations(calibrationFile(env)).find((c) => c.family === f);
    env.out(
      `${f.padEnd(17)} mode ${effectiveJev(env, pp).modes[f] ?? "disabled"}   calibration ${cal ? `${cal.id} n=${cal.n} threshold=${cal.threshold ?? "none (unusable)"}` : "none"}`,
    );
  }
  return 0;
}

// Shadow report: what Jev would have changed, how often it failed, what it cost. Not an accuracy claim without labels.
export async function jevReport(env: Env): Promise<number> {
  const recs = readTelemetry(telemetryFile(env));
  const fams = [...new Set(recs.map((r) => r.family as string))];
  if (!fams.length) env.out("no Jev telemetry yet");
  for (const f of fams) {
    const rs = recs.filter((r) => r.family === f);
    const decided = rs.filter((r) => r.qid),
      skipped = rs.filter((r) => r.skipped),
      failed = rs.filter((r) => r.error);
    const changes = decided.filter((r) => r.jevChoice !== r.rulesDefault);
    const tok = decided.reduce((a, r) => a + (r.usage ? r.usage.input + r.usage.output : 0), 0);
    const models = [...new Set(decided.map((r) => r.resolvedModel))].join(", ") || "n/a";
    env.out(
      `${f}: ${decided.length} decisions · would change the rules' choice ${changes.length} · skipped ${skipped.length} · failed ${failed.length} · Jev tokens ${tok} · resolved model(s): ${models}`,
    );
    const lat = decided.map((r) => r.latencyMs as number).filter(Boolean);
    if (lat.length)
      env.out(
        `  mean latency ${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(0)} ms · confidence is a distribution statistic, not a measured probability of being right`,
      );
  }
  return 0;
}

// labels file: { "<stateHash>": "<correct option>" } from a human or a graded eval. Writes a per-family calibration.
export async function jevCalibrate(
  env: Env,
  family: Family,
  labelsFile: string,
  target = 0.95,
  minN = 30,
): Promise<number> {
  const labels = JSON.parse(readFileSync(labelsFile, "utf8")) as Record<string, string>;
  const rows = readTelemetry(telemetryFile(env))
    .filter((r) => r.family === family && r.qid && labels[r.stateHash])
    .map((r) => ({
      confidence: r.confidence as number,
      jevChoice: r.jevChoice as string,
      truth: labels[r.stateHash]!,
    }));
  const cal = calibrate(family, rows, target, minN);
  saveCalibrations(calibrationFile(env), [
    ...loadCalibrations(calibrationFile(env)).filter((c) => c.family !== family),
    { id: cal.id, family, threshold: cal.threshold, n: cal.n, target },
  ]);
  env.out(
    `${family}: n=${cal.n} labelled, threshold ${cal.threshold ?? "none: not enough accurate high-confidence data, so Jev cannot act"}  (target ${target}, min n ${minN})`,
  );
  for (const b of cal.bins.filter((x) => x.n))
    env.out(`  confidence ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}: n=${b.n} accuracy ${(b.accuracy! * 100).toFixed(0)}%`);
  return 0;
}

// ---------------- controlled learning ----------------

export async function learnCapture(env: Env, taskId: string): Promise<number> {
  const inc = learn.captureIncident(env.home, taskId);
  env.out(inc ? `incident ${inc.id}: ${inc.facts.join("; ")}` : "nothing verified to learn from in that task");
  return inc ? 0 : 1;
}

// Proposals are written to quarantine; nothing a worker sees changes. The file is a Proposal minus id/state/createdAt.
export async function learnPropose(env: Env, file: string): Promise<number> {
  const input = JSON.parse(readFileSync(file, "utf8"));
  const holdoutDir = env.evalsRoot ? join(env.evalsRoot, "holdout") : undefined;
  const p = learn.propose(env.home, input, holdoutDir ? { holdoutDir } : {});
  env.out(
    `proposal ${p.id} quarantined (lesson ${p.lesson.id}, topic ${p.lesson.topic}). Not active. Evaluate it, then a person promotes it.`,
  );
  return 0;
}

export async function learnList(env: Env): Promise<number> {
  const cur = learn.currentReleaseId(env.home);
  env.out(
    `active release: ${cur ?? "none"}  lessons: ${
      learn
        .activeLessons(env.home, {})
        .lessons.map((l) => l.id)
        .join(", ") || "none"
    }`,
  );
  for (const p of learn.listProposals(env.home))
    env.out(`${p.id}  ${p.state.padEnd(11)} ${p.lesson.topic}${p.evaluation ? `  eval=${p.evaluation.verdict}` : ""}`);
  return 0;
}

export async function learnPromote(env: Env, proposalId: string): Promise<number> {
  const p = learn.getProposal(env.home, proposalId);
  env.out(`lesson [${p.lesson.topic}]: ${p.lesson.text}`);
  const rel = learn.promote(env.home, proposalId, `operator:${env.user}`);
  env.out(
    `promoted: release ${rel.id} (rollback target ${rel.rollbackTarget ?? "none"}). Applies to tasks started from now on.`,
  );
  return 0;
}
export async function learnRollback(env: Env, toRelease?: string): Promise<number> {
  const rel = learn.rollback(env.home, toRelease);
  env.out(`active release is now ${rel.id}: ${rel.note}`);
  return 0;
}
export async function learnRetire(env: Env, lessonId: string, purgeToo = false): Promise<number> {
  if (purgeToo) learn.purge(env.home, lessonId, `operator:${env.user}`);
  else learn.retire(env.home, lessonId, `operator:${env.user}`);
  env.out(`${purgeToo ? "purged" : "retired"} ${lessonId}`);
  return 0;
}

// Usage statistics from the persisted task history. Default scope: tasks of the current project; --all for every
// project of this user; --since accepts an ISO date or Nd (e.g. 7d). Spend and outcomes only: no savings claim.
// One command from a goal to a running task. The contract is derived deterministically: files are the ones you name
// (or, if you name none, what is already changed in the tree, since scope is never guessed from the goal's words),
// the tier is the risk floor of those paths, and acceptance is the goal plus "required gates pass".
export async function doTask(env: Env, goal: string, o: { files?: string[] } = {}): Promise<number> {
  if (!workflowEnabled(env)) {
    env.out("The managed workflow is turned off (.agents/policy.json: enabled false). Nothing was run.");
    return 2;
  }
  let files = o.files ?? [];
  if (files.length === 0) {
    const st = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: env.project,
      encoding: "utf8",
    });
    files = st.stdout
      .split("\n")
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3).split(" -> ").pop()!);
  }
  if (files.length === 0)
    throw new CliError("no files in scope: pass --files a.ts,b.ts (the controller will not guess scope from the goal)");
  const tier = riskFloor({ paths: files });
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
    .replace(/-$/, "");
  const id = `${slug.length >= 3 ? slug : "task"}-${Date.now().toString(36)}`;
  const contract = {
    schemaVersion: 1,
    id,
    goal,
    originalRequest: goal.slice(0, 500),
    acceptance: [`The change does what was asked: ${goal}`.slice(0, 500), "All required gates pass and discover tests"],
    files,
    riskTier: tier,
    budget: files.length <= 2 ? "narrow" : files.length <= 6 ? "standard" : "complex",
  };
  const tmp = join(env.home, `do-${id}.json`);
  mkdirSync(env.home, { recursive: true });
  writeFileSync(tmp, JSON.stringify(contract, null, 2));
  try {
    await taskCreate(env, tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
  const code = await taskRun(env, id);
  env.out(
    `next: node scripts/agentic.mjs status ${id}${tier === "R2" || tier === "R3" ? ` (a plan needs your approval: approve ${id})` : ""} · when verified: accept ${id}`,
  );
  return code;
}

// Called by the project's Stop hook. Exit 2 = the gates failed on the current working tree (diagnostic on stdout).
export async function sessionCheckCmd(env: Env, reuse = false): Promise<number> {
  const f = projectFile(env, "policy.json");
  if (!existsSync(f) || !workflowEnabled(env)) return 0;
  const pp = loadValidated<ProjectPolicy>(f, "policy");
  return sessionCheck({
    home: env.home,
    project: env.project,
    gates: pp.gates,
    requiredGates: pp.requiredGates,
    reuse,
    out: env.out,
  });
}

export async function prSummaryCmd(env: Env, update: boolean): Promise<number> {
  env.out(update ? updatePr(env.home, env.project) : prSummary(env.home, env.project));
  return 0;
}

export async function stats(env: Env, o: { all?: boolean; since?: string; json?: boolean } = {}): Promise<number> {
  let tasks = allTasks(env.home);
  if (!o.all) tasks = tasks.filter((t) => t.project === env.project);
  let from: number | undefined;
  if (o.since) {
    const m = /^(\d+)d$/.exec(o.since);
    from = m ? Date.now() - Number(m[1]) * 86_400_000 : Date.parse(o.since);
    if (!Number.isFinite(from)) throw new CliError(`--since must be an ISO date or Nd, got ${o.since}`);
    tasks = tasks.filter((t) => t.createdAt && Date.parse(t.createdAt) >= from!); // tasks without a date are excluded, not guessed
  }
  const act = learn.activeLessons(env.home, {});
  const s = summarizeTasks(
    tasks,
    o.all ? "all projects" : env.project,
    readTelemetry(telemetryFile(env)),
    {
      release: act.releaseId,
      count: act.lessons.length,
    },
    readSessions(env.home, true).filter(
      (r) => (o.all || r.project === env.project) && (from === undefined || Date.parse(r.ts) >= from),
    ),
  );
  env.out(o.json ? JSON.stringify(s, null, 2) : formatStats(s));
  return 0;
}

// Explicit enable/disable commands work in every harness.
function setEnabled(env: Env, on: boolean): void {
  const f = projectFile(env, "policy.json");
  const policy = loadValidated<ProjectPolicy>(f, "policy");
  writeFileSync(f, `${JSON.stringify({ ...policy, enabled: on }, null, 2)}\n`);
}
export async function enableWorkflow(env: Env): Promise<number> {
  setEnabled(env, true);
  env.out("managed workflow: ON");
  return 0;
}
export async function disableWorkflow(env: Env): Promise<number> {
  setEnabled(env, false);
  env.out("managed workflow: OFF (commit .agents/policy.json to share this; re-enable with `agentic enable`)");
  return 0;
}

// Architecture boundaries from .agents/architecture.json, analysed with the TypeScript compiler. Exit 0 = clean,
// 1 = findings (violations, unanalysable constructs, empty scans), 2 = analysis unavailable (never reported as a pass).
export async function archCheck(env: Env): Promise<number> {
  const file = projectFile(env, "architecture.json");
  if (!existsSync(file))
    throw new CliError("no .agents/architecture.json: define layers to check (see schemas/architecture.schema.json)");
  const cfg = loadValidated<ArchConfig>(file, "architecture");
  try {
    const r = await checkArchitecture(env.project, cfg);
    env.out(formatReport(r));
    return r.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof ArchUnavailable) {
      env.out(`architecture: UNAVAILABLE. ${e.message}`);
      return 2;
    }
    throw e;
  }
}
