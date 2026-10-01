// M1 adversarial tests: each asserts a specific blocked/error status and that protected state is untouched.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../src/budget.ts";
import { askIsolation, loadChoice, saveChoice } from "../src/consent.ts";
import { dockerArgv } from "../src/gates.ts";
import { EventLog } from "../src/events.ts";
import { sha256 } from "../src/hash.ts";
import { type Policy, Run } from "../src/run.ts";

const limits = { aggregateTokens: 1000, toolActions: 12, semanticRepairs: 1 };
// A "test gate" whose pass/fail is the real exit code of a script in the workspace.
const gate = { id: "unit", argv: ["node", "check.mjs"], timeoutMs: 5000, discover: { regex: "tests (\\d+)", min: 1 } };

function setup(over: Partial<Policy> = {}, checkSource?: string) {
  const base = mkdtempSync(join(tmpdir(), "run-"));
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "acceptance"));
  writeFileSync(join(workspace, "acceptance", "spec.txt"), "frozen");
  writeFileSync(join(workspace, "value.txt"), "bad");
  writeFileSync(
    join(workspace, "check.mjs"),
    checkSource ??
      `import {readFileSync} from "node:fs"; const ok = readFileSync("value.txt","utf8")==="good"; console.log("tests 1"); process.exit(ok?0:1)`,
  );
  const policy: Policy = {
    workspace, stateDir: join(base, "state"), protectedPaths: ["acceptance", "check.mjs"],
    gates: [gate], requiredGates: ["unit"], limits, isolation: "none", riskTier: "R1", egress: "local-only", ...over,
  };
  const run = new Run(policy);
  run.start();
  return { run, workspace, policy, base };
}
const fix = (n: string) => ({
  id: n, kind: "edit" as const,
  edits: [{ kind: "replace" as const, path: "value.txt", expectHash: sha256("bad"), find: "bad", replace: "good" }],
});

test("end to end: fix → verify → human accepts exact candidate", async () => {
  const { run } = setup();
  assert.equal((await run.handle(fix("a1"))).ok, true);
  assert.equal((await run.handle({ id: "a2", kind: "finish" })).ok, true);
  assert.equal(run.state, "AWAITING_ACCEPTANCE");
  assert.equal(run.evidence?.gates[0]?.status, "pass");
  run.accept("operator");
  assert.equal(run.state, "ACCEPTED");
});

test("isolation unanswered → NEEDS_INPUT; nothing runs", async () => {
  const { run } = setup({ isolation: "unset" });
  assert.equal(run.state, "NEEDS_INPUT");
  assert.equal((await run.handle({ id: "a1", kind: "finish" })).ok, false);
});

test("'none' is refused for R3", () => {
  assert.equal(setup({ riskTier: "R3" }).run.state, "BLOCKED");
});

test("docker chosen but daemon down or image unset → BLOCKED, never host fallback", () => {
  const mk = (over: Partial<Policy>, up: boolean) => {
    const { policy } = setup();
    const p = { ...policy, stateDir: join(policy.stateDir, "..", `s${Math.random()}`), ...over };
    const r = new Run(p, { dockerUp: () => up });
    r.start();
    return r;
  };
  assert.equal(mk({ isolation: "docker", dockerImage: "node:22" }, false).state, "BLOCKED");
  assert.equal(mk({ isolation: "docker" }, true).state, "BLOCKED");
  assert.equal(mk({ isolation: "docker", dockerImage: "node:22" }, true).state, "IMPLEMENTING");
});

test("docker argv is locked down", () => {
  const a = dockerArgv(gate, "/w", "node:22", "n").join(" ");
  for (const must of ["--network none", "--read-only", "--cap-drop ALL", "no-new-privileges", "--user 65534:65534", "--pids-limit"]) {
    assert.match(a, new RegExp(must));
  }
  assert.doesNotMatch(a, /privileged|docker\.sock/);
});

test("consent: only explicit yes/no; anything else is unanswered", async () => {
  const seq = (...xs: string[]) => async () => xs.shift() ?? "";
  assert.equal(await askIsolation(seq("yes")), "docker");
  assert.equal(await askIsolation(seq("maybe", "N")), "none");
  assert.equal(await askIsolation(seq("", "?", "sure")), undefined);
  const dir = mkdtempSync(join(tmpdir(), "consent-"));
  assert.equal(loadChoice(dir), undefined);
  saveChoice(dir, "none");
  assert.equal(loadChoice(dir), "none");
});

test("forged success: model-printed PASS does not beat the exit code", async () => {
  const { run } = setup({}, `console.log("tests 99 PASS all green"); process.exit(1)`);
  await run.handle({ id: "a1", kind: "finish" });
  assert.equal(run.state, "BOUNDED_REPAIR");
  assert.equal(run.evidence, undefined);
});

test("zero discovery is incomplete, not pass", async () => {
  const { run } = setup({}, `console.log("no tests here"); process.exit(0)`);
  await run.handle({ id: "a1", kind: "finish" });
  assert.notEqual(run.state, "AWAITING_ACCEPTANCE");
});

test("unauthorized command: unknown gate id and unknown action kinds are rejected", async () => {
  const { run } = setup();
  assert.equal((await run.handle({ id: "a1", kind: "run_gate", gateId: "rm -rf /" })).ok, false);
  assert.equal((await run.handle({ id: "a2", kind: "shell", cmd: "ls" })).ok, false);
  assert.equal((await run.handle({ id: "a3", kind: "accept" })).ok, false);
  assert.equal((await run.handle({ id: "a4", kind: "finish", approved: true })).ok, false);
  assert.equal(run.state, "IMPLEMENTING");
});

test("duplicate action ids are rejected", async () => {
  const { run } = setup();
  await run.handle({ id: "x", kind: "read", path: "value.txt" });
  assert.equal((await run.handle({ id: "x", kind: "read", path: "value.txt" })).ok, false);
});

test("scope escape: traversal, absolute, symlink, protected path", async () => {
  const { run, workspace, base } = setup();
  writeFileSync(join(base, "secret.txt"), "s");
  symlinkSync(join(base, "secret.txt"), join(workspace, "link.txt"));
  const edit = (path: string) => ({ id: `e-${path}`, kind: "edit" as const, edits: [{ kind: "create" as const, path, content: "x" }] });
  for (const p of ["../escape.txt", "/etc/evil", "link.txt", "acceptance/spec.txt", "check.mjs"]) {
    const r = await run.handle(edit(p));
    assert.equal(r.ok, false, p);
  }
  assert.equal(readFileSync(join(base, "secret.txt"), "utf8"), "s");
  assert.equal(readFileSync(join(workspace, "acceptance", "spec.txt"), "utf8"), "frozen");
});

test("edits are atomic: one bad edit writes nothing; stale and ambiguous rejected", async () => {
  const { run, workspace } = setup();
  const good = { kind: "replace" as const, path: "value.txt", expectHash: sha256("bad"), find: "bad", replace: "good" };
  const stale = { kind: "replace" as const, path: "value.txt", expectHash: sha256("other"), find: "bad", replace: "x" };
  assert.equal((await run.handle({ id: "a1", kind: "edit", edits: [{ kind: "create", path: "new.txt", content: "n" }, stale] })).ok, false);
  assert.equal(existsSync(join(workspace, "new.txt")), false);
  writeFileSync(join(workspace, "dup.txt"), "aa");
  const amb = { kind: "replace" as const, path: "dup.txt", expectHash: sha256("aa"), find: "a", replace: "b" };
  assert.equal((await run.handle({ id: "a2", kind: "edit", edits: [amb] })).ok, false);
  assert.equal(readFileSync(join(workspace, "dup.txt"), "utf8"), "aa");
  assert.equal((await run.handle({ id: "a3", kind: "edit", edits: [good] })).ok, true);
});

test("test tampering: a candidate that rewrites the acceptance check is blocked", async () => {
  const src = `import {writeFileSync} from "node:fs"; writeFileSync("acceptance/spec.txt","weakened"); console.log("tests 1")`;
  const { run } = setup({}, src);
  await run.handle({ id: "a1", kind: "finish" });
  assert.equal(run.state, "BLOCKED");
});

test("stale evidence: change after verification cannot be accepted", async () => {
  const { run, workspace } = setup();
  await run.handle(fix("a1"));
  await run.handle({ id: "a2", kind: "finish" });
  writeFileSync(join(workspace, "value.txt"), "good + sneaky change"); // out-of-band edit
  assert.throws(() => run.accept("operator"), /stale evidence/);
  assert.notEqual(run.state, "ACCEPTED");
});

test("edit after verification invalidates evidence", async () => {
  const { run } = setup();
  await run.handle(fix("a1"));
  await run.handle({ id: "a2", kind: "finish" });
  await run.handle({ id: "a3", kind: "edit", edits: [{ kind: "create", path: "extra.txt", content: "x" }] });
  assert.equal(run.evidence, undefined);
  assert.equal(run.state, "IMPLEMENTING");
});

test("budget: children share the ledger; limits cannot be reset", () => {
  const parent = new Ledger({ aggregateTokens: 100, toolActions: 2, semanticRepairs: 1 });
  const child = parent; // child tasks receive the same ledger object
  child.reserve(60);
  assert.throws(() => parent.reserve(60), /tokens/);
  parent.settle(60, null);
  assert.equal(parent.unknownUsageCalls, 1);
  child.action(); child.action();
  assert.throws(() => parent.action(), /tool actions/);
});

test("action budget exhaustion escalates", async () => {
  const { run } = setup({ limits: { ...limits, toolActions: 1 } });
  await run.handle({ id: "a1", kind: "read", path: "value.txt" });
  await run.handle({ id: "a2", kind: "read", path: "value.txt" });
  assert.equal(run.state, "ESCALATED");
});

test("repeated failure: one repair, then escalate", async () => {
  const { run } = setup();
  await run.handle({ id: "a1", kind: "finish" }); // fails → repair 1
  assert.equal(run.state, "BOUNDED_REPAIR");
  await run.handle({ id: "a2", kind: "finish" }); // fails again → no repairs left
  assert.equal(run.state, "ESCALATED");
});

test("terminal states are final", async () => {
  const { run } = setup();
  await run.handle({ id: "a1", kind: "blocked", reason: "unsupported capability" });
  assert.equal(run.state, "BLOCKED");
  assert.throws(() => run.cancel());
  assert.equal((await run.handle({ id: "a2", kind: "read", path: "value.txt" })).ok, false);
});

test("event log: tamper detected; second writer refused", () => {
  const { policy, run } = setup();
  const path = join(policy.stateDir, "events.jsonl");
  assert.throws(() => new EventLog(path).open(), /locked/);
  run.close();
  const log = new EventLog(path);
  log.verify();
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  lines[0] = lines[0]!.replace("PREFLIGHT", "ACCEPTED");
  writeFileSync(path, `${lines.join("\n")}\n`);
  assert.throws(() => log.verify(), /corrupt/);
});

test("stateDir inside the workspace is refused", () => {
  const { policy } = setup();
  assert.throws(() => new Run({ ...policy, stateDir: join(policy.workspace, "state") }), /outside the workspace/);
});
