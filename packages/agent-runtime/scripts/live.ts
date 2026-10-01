// Live pilot against a REAL provider. Not part of `npm test`; spends money when PROVIDER=claude.
//   PROVIDER=claude MODEL=claude-haiku-4-5-20251001 CASE=fix|blocked node scripts/live.ts
//   PROVIDER=ollama MODEL=<already-pulled tag> ...        (optional; needs a local Ollama)
// Pulls nothing. Gates run on the host (isolation "none", R1) in a temp dir. Hosted egress is the
// user's explicit choice via PROVIDER=claude, recorded as policy egress "hosted-allowed".
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliProvider } from "../src/claude.ts";
import { drive } from "../src/drive.ts";
import { OllamaProvider } from "../src/ollama.ts";
import type { GenerationProvider } from "../src/provider.ts";
import { Run } from "../src/run.ts";

const kind = process.env.PROVIDER ?? "";
const model = process.env.MODEL ?? "";
if (!model) throw new Error("set MODEL to an exact model id/tag");
let provider: GenerationProvider;
if (kind === "claude") provider = new ClaudeCliProvider({ model, maxBudgetUsd: 0.05, timeoutMs: 120_000 });
else if (kind === "ollama") {
  const o = new OllamaProvider({ baseUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434", model, numCtx: Number(process.env.OLLAMA_CTX ?? 4096), temperature: 0, timeoutMs: 120_000 });
  const probe = await o.probe();
  if (!probe.ok) throw new Error(`doctor: ${probe.reason}`);
  provider = o;
} else throw new Error("PROVIDER must be claude or ollama");

const base = mkdtempSync(join(tmpdir(), "live-"));
const ws = join(base, "ws");
mkdirSync(ws);
writeFileSync(join(ws, "greeting.mjs"), `export const greeting = () => "helo";\n`);
writeFileSync(join(ws, "check.mjs"), `import {greeting} from "./greeting.mjs"; console.log("tests 1"); process.exit(greeting()==="hello"?0:1)\n`);
const tasks = {
  fix: { goal: "greeting() must return the string hello (it has a typo)", acceptance: ["check.mjs exits 0"], files: ["greeting.mjs"] },
  // The spec the task depends on does not exist: the right outcome is blocked/needs-input, not invention.
  blocked: { goal: "Make greeting() return the greeting text defined in docs/greeting-spec.md", acceptance: ["greeting matches the spec"], files: ["greeting.mjs"] },
};
const task = tasks[(process.env.CASE ?? "fix") as keyof typeof tasks];
const run = new Run({
  workspace: ws, stateDir: join(base, "state"), protectedPaths: ["check.mjs"], riskTier: "R1",
  egress: kind === "claude" ? "hosted-allowed" : "local-only", isolation: "none",
  gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 10_000, discover: { regex: "tests (\\d+)", min: 1 } }],
  requiredGates: ["unit"], limits: { aggregateTokens: 12_000, toolActions: 6, semanticRepairs: 1 },
});
run.start();
const t = Date.now();
const turns = await drive(run, provider, ws, task, 6, 1500, 3000);
console.log(JSON.stringify({ provider: provider.id, case: process.env.CASE ?? "fix", state: run.state, turns, tokens: run.ledger.tokens, costUsd: run.ledger.costUsd, unknownUsageCalls: run.ledger.unknownUsageCalls, wallMs: Date.now() - t, stateDir: join(base, "state") }, null, 2));
run.close();
