// Live M2 pilot: one tiny R1 task against a REAL local Ollama model. Not part of `npm test`.
//   OLLAMA_MODEL=<already-pulled tag> node scripts/live-ollama.ts [--accept]
// Pulls nothing, enables nothing paid, runs gates on the host (isolation "none", R1 only) in a temp dir.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drive } from "../src/drive.ts";
import { OllamaProvider } from "../src/ollama.ts";
import { Run } from "../src/run.ts";

const model = process.env.OLLAMA_MODEL;
if (!model) throw new Error("set OLLAMA_MODEL to an already-pulled tag");
const provider = new OllamaProvider({ baseUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434", model, numCtx: Number(process.env.OLLAMA_CTX ?? 4096), temperature: 0, timeoutMs: 120_000 });
const probe = await provider.probe();
if (!probe.ok) throw new Error(`doctor: ${probe.reason}`);

const base = mkdtempSync(join(tmpdir(), "live-"));
const ws = join(base, "ws");
mkdirSync(ws);
writeFileSync(join(ws, "greeting.mjs"), `export const greeting = () => "helo";\n`);
writeFileSync(join(ws, "check.mjs"), `import {greeting} from "./greeting.mjs"; console.log("tests 1"); process.exit(greeting()==="hello"?0:1)\n`);
const run = new Run({
  workspace: ws, stateDir: join(base, "state"), protectedPaths: ["check.mjs"], riskTier: "R1", isolation: "none",
  gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 10_000, discover: { regex: "tests (\\d+)", min: 1 } }],
  requiredGates: ["unit"], limits: { aggregateTokens: 12_000, toolActions: 6, semanticRepairs: 1 },
});
run.start();
const t = Date.now();
const turns = await drive(run, provider, ws, { goal: "greeting() must return the string hello (it has a typo)", acceptance: ["check.mjs exits 0"], files: ["greeting.mjs"] }, 6, 1500, 3000);
console.log(JSON.stringify({ model: provider.id, state: run.state, turns, tokens: run.ledger.tokens, unknownUsageCalls: run.ledger.unknownUsageCalls, wallMs: Date.now() - t, state_dir: join(base, "state") }, null, 2));
run.close();
