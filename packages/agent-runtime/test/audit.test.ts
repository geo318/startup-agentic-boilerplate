import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compile } from "../src/context.ts";
import { runGate } from "../src/gates.ts";
import { budgetProvider, type Spend, type GenerationProvider } from "../src/provider.ts";
import { Ledger } from "../src/budget.ts";
import { resolveSafe } from "../src/paths.ts";

const temp = (t: { after: (f: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("context resolves extension-bearing callers, retains explicit new files, and rejects missing inputs", (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, "value.mjs"), "export const value = 1;");
  writeFileSync(join(dir, "caller.mjs"), 'import {value} from "./value.mjs"; console.log(value);');
  const p = compile(dir, ["value.mjs", "new.py"], 4000, { allowMissing: ["new.py"] });
  assert.ok(p.excerpts.some((e) => e.path === "caller.mjs"));
  assert.match(p.excerpts.find((e) => e.path === "new.py")!.text, /new file/);
  assert.throws(() => compile(dir, ["missing-spec.md"], 4000), /ENOENT/);
});

test("noisy successful gates retain discovery and final diagnostics", async (t) => {
  const result = await runGate(
    {
      id: "noisy",
      argv: [
        process.execPath,
        "-e",
        'process.stdout.write("x".repeat(200000)); setTimeout(()=>console.log("\\ntests 7\\nlast diagnostic"),20)',
      ],
      timeoutMs: 5000,
      discover: { regex: "tests (\\d+)", min: 7 },
    },
    temp(t),
    "snapshot",
  );
  assert.equal(result.status, "pass");
  assert.equal(result.discovered, 7);
  assert.match(result.outputTail, /last diagnostic/);
  assert.ok(result.outputTail.length <= 65536);
});

test("one spending account bounds probes and task calls, and stops on unknown billing", async () => {
  const spend: Spend = { limitUsd: 0.05, costUsd: 0, calls: 0, tokens: 0, unknownCostCalls: 0, unknownUsageCalls: 0 };
  const caps: number[] = [];
  const provider: GenerationProvider = {
    id: "fake",
    hosted: true,
    supportsCostLimit: true,
    async generate(req) {
      caps.push(req.maxCostUsd!);
      return {
        content: "",
        finishReason: "error",
        latencyMs: 1,
        usage: { input: 10, output: 2 },
        costUsd: Math.min(0.03, req.maxCostUsd!),
      };
    },
  };
  const probe = budgetProvider(provider, spend),
    worker = budgetProvider(provider, spend);
  const req = { system: "", prompt: "", maxOutputTokens: 10 };
  await probe.generate(req);
  await worker.generate(req);
  assert.deepEqual(caps, [0.05, 0.05 - 0.03]);
  await assert.rejects(worker.generate(req), /spending stopped/);
  assert.equal(spend.calls, 2);
  assert.equal(spend.tokens, 24);
  const unknown = { ...spend, costUsd: 0, calls: 0 };
  const p = budgetProvider(
    {
      ...provider,
      async generate() {
        return { content: "", finishReason: "error", latencyMs: 1, usage: null };
      },
    },
    unknown,
  );
  await p.generate(req);
  await assert.rejects(p.generate(req), /unknown billing/);
  const ledger = new Ledger({ aggregateTokens: 100, toolActions: 2, semanticRepairs: 1 });
  ledger.settle(ledger.reserve(50), 40, undefined, true);
  assert.equal(ledger.unknownUsageCalls, 0);
  assert.equal(ledger.unknownCostCalls, 1);
});

test("internal symlink aliases cannot bypass protected paths", (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, ".agents"));
  writeFileSync(join(dir, ".agents/policy.json"), "{}");
  symlinkSync(".agents", join(dir, "alias"));
  assert.throws(() => resolveSafe(dir, "alias/policy.json", [".agents"]), /protected path/);
});

test("spending rejects invalid caps before calls and keeps callback errors separate from unknown billing", async () => {
  let calls = 0,
    reports = 0;
  const spend: Spend = { limitUsd: 1, costUsd: 0, calls: 0, tokens: 0, unknownCostCalls: 0, unknownUsageCalls: 0 };
  const provider: GenerationProvider = {
    id: "fake",
    hosted: true,
    supportsCostLimit: true,
    async generate() {
      calls++;
      return { content: "", finishReason: "stop", latencyMs: 1, costUsd: 0.01, usage: { input: 2, output: 1 } };
    },
  };
  const req = { system: "", prompt: "", maxOutputTokens: 10 };
  for (const limit of [0, -1, NaN, Infinity]) {
    await assert.rejects(budgetProvider(provider, { ...spend, limitUsd: limit }).generate(req), /invalid budget/);
    await assert.rejects(budgetProvider(provider, spend).generate({ ...req, maxCostUsd: limit }), /invalid budget/);
  }
  assert.equal(calls, 0);
  await assert.rejects(
    budgetProvider(provider, spend, () => {
      reports++;
      throw new Error("disk full");
    }).generate(req),
    /disk full/,
  );
  assert.equal(calls, 1);
  assert.equal(reports, 1);
  assert.equal(spend.costUsd, 0.01);
  assert.equal(spend.tokens, 3);
  assert.equal(spend.unknownCostCalls, 0);
  assert.equal(spend.unknownUsageCalls, 0);
  await assert.rejects(
    budgetProvider(
      {
        ...provider,
        async generate() {
          throw new Error("connection lost");
        },
      },
      spend,
    ).generate(req),
    /connection lost/,
  );
  assert.equal(spend.unknownCostCalls, 1);
  assert.equal(spend.unknownUsageCalls, 1);
});
