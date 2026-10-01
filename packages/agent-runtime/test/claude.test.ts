import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeCliProvider } from "../src/claude.ts";
import { drive } from "../src/drive.ts";
import { type Policy, Run } from "../src/run.ts";

// A stand-in `claude` that records its argv/stdin and prints a canned result. Proves how we invoke the CLI.
function fakeClaude(result: object) {
  const dir = mkdtempSync(join(tmpdir(), "fc-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node\nlet s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(join(dir, "seen.json"))},JSON.stringify({argv:process.argv.slice(2),stdin:s,cwd:process.cwd()}));console.log(${JSON.stringify(JSON.stringify(result))})})\n`);
  chmodSync(bin, 0o755);
  return { bin, seen: () => JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")) };
}
const ok = { subtype: "success", is_error: false, terminal_reason: "completed", total_cost_usd: 0.003, usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 200 }, structured_output: { id: "1", kind: "finish" } };
const profile = (bin: string) => ({ model: "claude-haiku-4-5-20251001", maxBudgetUsd: 0.05, timeoutMs: 5000, bin });

test("claude cli: text-only invocation, structured output, usage and cost captured", async () => {
  const f = fakeClaude(ok);
  const r = await new ClaudeCliProvider(profile(f.bin)).generate({ system: "SYS", prompt: "PROMPT", maxOutputTokens: 100, schema: { type: "object" } });
  assert.equal(r.content, '{"id":"1","kind":"finish"}');
  assert.deepEqual(r.usage, { input: 1200, output: 50 });
  assert.equal(r.costUsd, 0.003);
  const { argv, stdin } = f.seen();
  assert.equal(stdin, "PROMPT");
  const joined = argv.join("\u0000");
  for (const must of ["--tools\u0000\u0000", "--no-session-persistence", "--strict-mcp-config", "--setting-sources\u0000\u0000", "--disable-slash-commands", "--max-budget-usd\u00000.05", "--model\u0000claude-haiku-4-5-20251001"]) {
    assert.ok(joined.includes(must), must);
  }
  assert.ok(!argv.includes("--allowedTools") && !argv.includes("--dangerously-skip-permissions"));
});

test("claude cli: errors, is_error, garbage → non-executable error", async () => {
  for (const bad of [{ ...ok, is_error: true }, { ...ok, subtype: "error_max_budget_usd" }, { ...ok, terminal_reason: "max_turns" }]) {
    assert.equal((await new ClaudeCliProvider(profile(fakeClaude(bad).bin)).generate({ system: "", prompt: "", maxOutputTokens: 1 })).finishReason, "error");
  }
  assert.equal((await new ClaudeCliProvider(profile("/nonexistent/claude")).generate({ system: "", prompt: "", maxOutputTokens: 1 })).finishReason, "error");
});

function runWith(egress: Policy["egress"]) {
  const base = mkdtempSync(join(tmpdir(), "eg-"));
  const ws = join(base, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "a.txt"), "x");
  const run = new Run({ workspace: ws, stateDir: join(base, "s"), protectedPaths: [], riskTier: "R1", egress, isolation: "none", gates: [], requiredGates: [], limits: { aggregateTokens: 10_000, toolActions: 5, semanticRepairs: 1 } });
  run.start();
  return { run, ws };
}

test("data egress: hosted provider is blocked under local-only, before any call", async () => {
  const f = fakeClaude(ok);
  const { run, ws } = runWith("local-only");
  await drive(run, new ClaudeCliProvider(profile(f.bin)), ws, { goal: "g", acceptance: [], files: ["a.txt"] });
  assert.equal(run.state, "BLOCKED");
  assert.throws(() => f.seen()); // the CLI was never invoked
});

test("hosted allowed: call happens and cost lands in the ledger", async () => {
  const f = fakeClaude({ ...ok, structured_output: { id: "1", kind: "blocked", reason: "x" } });
  const { run, ws } = runWith("hosted-allowed");
  await drive(run, new ClaudeCliProvider(profile(f.bin)), ws, { goal: "g", acceptance: [], files: ["a.txt"] });
  assert.equal(run.state, "BLOCKED");
  assert.equal(run.ledger.costUsd, 0.003);
  assert.equal(run.ledger.tokens, 1250);
});
