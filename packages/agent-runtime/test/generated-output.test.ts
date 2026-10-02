import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Policy, Run, snapshot } from "../src/run.ts";

function setup(mutation = "cache", riskTier: Policy["riskTier"] = "R1") {
  const root = mkdtempSync(join(tmpdir(), "generated-output-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, ".agents", ".turbo"), { recursive: true });
  mkdirSync(join(workspace, ".next"));
  writeFileSync(join(workspace, "source.ts"), "export const value = 1;");
  writeFileSync(join(workspace, ".agents/.turbo/policy.json"), "{}");
  writeFileSync(join(workspace, ".next/cache.test.ts"), "original test");
  const code = [
    'import {mkdirSync, writeFileSync} from "node:fs";',
    'mkdirSync(".turbo/cache", {recursive:true}); writeFileSync(".turbo/cache/new.json", "{}");',
    'mkdirSync("apps/web/.next/types", {recursive:true}); writeFileSync("apps/web/.next/types/routes.d.ts", "export {}");',
    'writeFileSync("apps/web/tsconfig.tsbuildinfo", "new metadata");',
    mutation === "source" ? 'writeFileSync("source.ts", "changed");' : "",
    mutation === "protected" ? 'writeFileSync(".agents/.turbo/policy.json", "changed");' : "",
    mutation === "test" ? 'writeFileSync(".next/cache.test.ts", "weakened");' : "",
    'console.log("tests 1");',
  ].join("\n");
  const policy: Policy = {
    workspace,
    stateDir: join(root, "state"),
    protectedPaths: [".agents"],
    writePaths: ["source.ts"],
    protectExistingTests: true,
    gates: [
      {
        id: "types",
        argv: [process.execPath, "-e", code],
        discover: { regex: "tests (\\d+)", min: 1 },
        timeoutMs: 5000,
      },
    ],
    requiredGates: ["types"],
    limits: { aggregateTokens: 1000, toolActions: 5, semanticRepairs: 1 },
    riskTier,
    egress: "local-only",
  };
  const run = new Run(policy);
  run.start();
  if (riskTier === "R2") run.approvePlan("owner", "plan");
  return { root, workspace, policy, run };
}

test("gates may generate caches, never alter source or protected files; full evidence survives resume", async () => {
  for (const mutation of ["cache", "source", "protected", "test"]) {
    const { root, workspace, policy, run } = setup(mutation);
    try {
      const before = snapshot(workspace);
      const result = await run.handle({ id: "finish", kind: "finish" });
      if (mutation === "cache") {
        assert.equal(result.ok, true);
        assert.equal(run.state, "AWAITING_ACCEPTANCE");
        assert.notEqual(snapshot(workspace), before); // caches remain in the evidence digest
        assert.deepEqual(run.changed(), []); // not worker edits or exported patches
        run.close();
        const resumed = new Run(policy);
        try {
          resumed.resume();
          assert.equal(resumed.state, "AWAITING_ACCEPTANCE");
          resumed.accept("owner");
          assert.equal(resumed.state, "ACCEPTED");
        } finally {
          resumed.close();
        }
      } else {
        assert.equal(result.ok, false);
        assert.equal(run.evidence, undefined);
        assert.equal(run.state, mutation === "source" ? "BOUNDED_REPAIR" : "BLOCKED");
      }
    } finally {
      run.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("late protected cache-path tampering is detected by acceptance, review and resume", async () => {
  for (const phase of ["accept", "review", "resume"]) {
    const { root, workspace, policy, run } = setup("cache", phase === "review" ? "R2" : "R1");
    try {
      assert.equal((await run.handle({ id: "finish", kind: "finish" })).ok, true);
      writeFileSync(join(workspace, ".agents/.turbo/policy.json"), "tampered after verification");
      if (phase === "accept") assert.throws(() => run.accept("owner"), /stale evidence/);
      else if (phase === "review") assert.equal(run.completeReview([]).ok, false);
      else {
        run.close();
        const resumed = new Run(policy);
        try {
          resumed.resume();
          assert.equal(resumed.state, "BLOCKED");
        } finally {
          resumed.close();
        }
      }
    } finally {
      run.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("workers cannot hide edits in generated paths, even with unrestricted write scope", async () => {
  const { root, policy, run } = setup();
  run.close();
  const worker = new Run({ ...policy, stateDir: join(root, "other-state"), writePaths: undefined });
  try {
    worker.start();
    symlinkSync(".next", join(policy.workspace, "cache-alias"));
    for (const path of [".next/new.ts", ".turbo/new.json", "app.tsbuildinfo", "cache-alias/new.ts"]) {
      const result = await worker.handle({
        id: path,
        kind: "edit",
        edits: [{ kind: "create", path, content: "hidden" }],
      });
      assert.equal(result.ok, false);
      assert.match(result.reason!, /generated build outputs/);
    }
  } finally {
    worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
