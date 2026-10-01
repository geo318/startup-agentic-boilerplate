// Live Jev SHADOW experiment on the synthetic dev-r1 cases. Spends Jev usage; sends only goal/acceptance/metadata
// (no source). Worker is a replay that blocks immediately, so no model-coding spend and nothing is executed.
//   TRIALS=3 node scripts/jev-shadow.ts          (credential from $AGENTIC_HOME/secrets.env)
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cli from "../src/cli/commands.ts";
import { loadSecrets } from "../src/secrets.ts";
import { readTelemetry } from "../src/jev/fabric.ts";
import { QualStore } from "../src/qualify.ts";
import { GATE, loadSuite } from "../src/eval.ts";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const secrets = loadSecrets(process.env.AGENTIC_HOME ?? join(homedir(), ".agentic"));
if (!secrets.JEV_API_KEY) throw new Error("no JEV_API_KEY in the user-level secrets store");
const trials = Number(process.env.TRIALS ?? 1);
const cases = loadSuite(join(root, "evals"), "dev-r1");
const home = mkdtempSync(join(tmpdir(), "jevshadow-"));
const out: string[] = [];
const labels: Record<string, string> = {};
const detail: Array<Record<string, unknown>> = [];
new QualStore(join(home, "qualifications.json")).record({ profileId: "mock/replay:w.json", family: "action-protocol", source: "owner-declared", passed: true, detail: {}, at: "t" });

for (let t = 1; t <= trials; t++) {
  for (const c of cases) {
    const project = mkdtempSync(join(tmpdir(), `jevproj-${c.id}-`));
    cpSync(join((c as any).dir, "project"), project, { recursive: true });
    cpSync(join(root, "project-setup/templates/.agents/skills"), join(project, ".agents/skills"), { recursive: true }); // public template skills: input for the skill-select family
    writeFileSync(join(project, "w.json"), JSON.stringify([JSON.stringify({ id: "a", kind: "blocked", reason: "shadow experiment: no work" })]));
    writeFileSync(join(project, ".agents/policy.json"), JSON.stringify({ schemaVersion: 1, protectedPaths: ["test", "package.json", ".agents"], gates: [GATE], requiredGates: ["tests"], baseline: "off", egress: "hosted-allowed", jev: { modes: { "workflow-select": "shadow", "skill-select": "shadow" }, allowSource: false, timeoutMs: 20000 } }));
    writeFileSync(join(project, ".agents/models.json"), JSON.stringify({ schemaVersion: 1, profiles: { w: { kind: "replay", file: join(project, "w.json") } }, roles: { worker: "w" } }));
    const env: cli.Env = { home, project, out: (s) => out.push(s), operatorTty: false, ask: async () => "", user: "shadow", dockerUp: () => false, secrets };
    const id = `${c.id}-t${t}`;
    writeFileSync(join(project, "contract.json"), JSON.stringify({ schemaVersion: 1, id, ...c.contract }));
    await cli.taskCreate(env, join(project, "contract.json"));
    mkdirSync(join(home, "tasks", id, "state"), { recursive: true });
    writeFileSync(join(home, "tasks", id, "state", "isolation-consent.json"), JSON.stringify({ isolation: "none", decidedAt: new Date().toISOString() }));
    try { await cli.taskRun(env, id); } catch (e) { out.push(`${id}: ${(e as Error).message}`); }
  }
}
const tel = readTelemetry(join(home, "telemetry", "jev.jsonl"));
const truthOf = new Map(cases.map((c) => [c.id, (c as any).jevTruth?.["workflow-select"] as string | undefined]));
const rows = tel.filter((r) => r.family === "workflow-select" && r.qid === "route").map((r) => {
  const caseId = String(r.taskId).replace(/-t\d+$/, "");
  const truth = truthOf.get(caseId);
  return { caseId, jevChoice: r.jevChoice, confidence: r.confidence, rulesDefault: r.rulesDefault, truth, correct: truth ? r.jevChoice === truth : null, probabilities: r.probabilities, model: r.resolvedModel, tokens: r.usage ? r.usage.input + r.usage.output : null, latencyMs: r.latencyMs, stateHash: r.stateHash };
});
for (const r of rows) if (r.truth) labels[r.stateHash as string] = r.truth;
writeFileSync(join(home, "labels.json"), JSON.stringify(labels));
for (const r of rows) console.log(`${r.caseId.padEnd(17)} jev=${String(r.jevChoice).padEnd(18)} conf=${Number(r.confidence).toFixed(3)} truth=${String(r.truth ?? "n/a").padEnd(18)} ${r.correct === null ? "" : r.correct ? "✓" : "✗"}`);
await cli.jevReport({ home, project: "", out: console.log, operatorTty: false, ask: async () => "", user: "x" });
await cli.jevCalibrate({ home, project: "", out: console.log, operatorTty: false, ask: async () => "", user: "x" }, "workflow-select", join(home, "labels.json"));
const labelled = rows.filter((r) => r.correct !== null);
const summary = { trials, decisions: rows.length, labelled: labelled.length, agree: labelled.filter((r) => r.correct).length, resolvedModels: [...new Set(rows.map((r) => r.model))], jevTokens: rows.reduce((a, r) => a + (r.tokens ?? 0), 0), skillSelectDecisions: tel.filter((r) => r.family === "skill-select" && r.qid).length, failures: tel.filter((r) => r.error).map((r) => r.error), rows: rows.map(({ stateHash, ...rest }) => rest) };
const file = join(root, "evals/baselines", `jev-shadow-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(summary, null, 2));
console.log(`labelled agreement ${summary.agree}/${summary.labelled}; skill-select decisions ${summary.skillSelectDecisions}; failures ${summary.failures.length}; saved ${file}`);
