// Live pilot with a configured profile; hosted calls require ALLOW_HOSTED=1.
// MODELS=<models.json> PROFILE=<name> CASE=fix|blocked node scripts/live.ts
// Pulls nothing. Gates run on the host (R1) in a temp directory.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectedProfile } from "./profile.ts";
import { drive } from "../src/drive.ts";
import { Run } from "../src/run.ts";

const { provider, hosted } = selectedProfile();

const base = mkdtempSync(join(tmpdir(), "live-"));
const ws = join(base, "ws");
mkdirSync(ws);
writeFileSync(join(ws, "greeting.mjs"), `export const greeting = () => "helo";\n`);
writeFileSync(
  join(ws, "check.mjs"),
  `import {greeting} from "./greeting.mjs"; console.log("tests 1"); process.exit(greeting()==="hello"?0:1)\n`,
);
const tasks = {
  fix: {
    goal: "greeting() must return the string hello (it has a typo)",
    acceptance: ["check.mjs exits 0"],
    files: ["greeting.mjs"],
  },
  // The spec the task depends on does not exist: the right outcome is blocked/needs-input, not invention.
  blocked: {
    goal: "Make greeting() return the greeting text defined in docs/greeting-spec.md",
    acceptance: ["greeting matches the spec"],
    files: ["greeting.mjs"],
  },
};
const task = tasks[(process.env.CASE ?? "fix") as keyof typeof tasks];
const run = new Run({
  workspace: ws,
  stateDir: join(base, "state"),
  protectedPaths: ["check.mjs"],
  riskTier: "R1",
  egress: hosted ? "hosted-allowed" : "local-only",

  gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 10_000, discover: { regex: "tests (\\d+)", min: 1 } }],
  requiredGates: ["unit"],
  limits: { aggregateTokens: 12_000, toolActions: 6, semanticRepairs: 1 },
});
run.start();
const t = Date.now();
const turns = await drive(run, provider, ws, task, 6, 1500, 3000);
console.log(
  JSON.stringify(
    {
      provider: provider.id,
      case: process.env.CASE ?? "fix",
      state: run.state,
      turns,
      tokens: run.ledger.tokens,
      costUsd: run.ledger.costUsd,
      unknownUsageCalls: run.ledger.unknownUsageCalls,
      wallMs: Date.now() - t,
      stateDir: join(base, "state"),
    },
    null,
    2,
  ),
);
run.close();
