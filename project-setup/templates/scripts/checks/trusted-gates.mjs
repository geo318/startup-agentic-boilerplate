#!/usr/bin/env node
// CI verifier for the final revision of a change. The gate definitions come from the BASE branch, never from
// the change being checked, so a pull request cannot replace the verifier that approves it.
//
//   trusted-gates.mjs --base <ref> [--policy .agents/policy.json] [--allow-protected-changes]
//
//   1. policy = `git show <base>:<policy>`            (the PR's own copy is ignored)
//   2. files changed since the merge base that fall under policy.protectedPaths → fail, unless
//      --allow-protected-changes (a deliberate maintenance review: the previous trusted policy still runs)
//   3. every requiredGate runs against the working tree; it must exit 0 AND discover >= min tests/files
// Runs with a minimal environment. The base-controlled workflow must grant only read permissions and expose no secrets to candidate code.

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const base = opt("--base");
const policyPath = opt("--policy") ?? ".agents/policy.json";
const allowProtected = args.includes("--allow-protected-changes");
const fail = (message) => {
  console.error(`::error::trusted-gates: ${message}`);
  process.exit(1);
};
if (!base) fail("usage: trusted-gates.mjs --base <ref>");

const git = (...a) => spawnSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const shown = git("show", `${base}:${policyPath}`);
if (shown.status !== 0) fail(`no ${policyPath} on ${base}: the base branch must define the gates it is judged by`);
let policy;
try {
  policy = JSON.parse(shown.stdout);
} catch {
  fail(`${policyPath} on ${base} is not valid JSON`);
}
if (!Array.isArray(policy.gates) || !Array.isArray(policy.requiredGates) || policy.requiredGates.length === 0) {
  fail("base policy needs gates and at least one requiredGate");
}

const changed = git("diff", "--name-only", `${base}...HEAD`);
if (changed.status !== 0) fail(`cannot diff against ${base}: ${changed.stderr.trim()}`);
const underProtected = (file) =>
  (policy.protectedPaths ?? []).some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));
const originalFiles = git("ls-tree", "-r", "--name-only", base);
if (originalFiles.status !== 0) fail("cannot inventory the base revision");
const acceptance = new Set(policy.protectExistingTests === false ? [] : originalFiles.stdout.split("\n").filter((p) => /(^|\/)(__tests__|tests?|specs?)(\/|$)|[._](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/.test(p)));
const touched = changed.stdout.split("\n").filter(Boolean).filter((p) => underProtected(p) || acceptance.has(p));
if (touched.length > 0) {
  const list = touched.slice(0, 20).join(", ");
  if (!allowProtected) fail(`protected paths changed (${list}). This needs a maintenance review; apply the maintenance label once reviewed.`);
  console.log(`protected paths changed (${list}); maintenance override in effect — gates still come from ${base}.`);
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
let failed = false;
for (const id of policy.requiredGates) {
  const gate = policy.gates.find((g) => g.id === id);
  if (!gate) fail(`required gate "${id}" is not defined in the base policy`);
  const run = spawnSync(gate.argv[0], gate.argv.slice(1), {
    encoding: "utf8", timeout: gate.timeoutMs, maxBuffer: 256 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "1", NO_COLOR: "1" },
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.replace(ANSI, "");
  const match = new RegExp(gate.discover.regex).exec(out);
  const found = match ? Number(match[1]) : 0;
  let verdict = "pass";
  if (run.error?.code === "ETIMEDOUT") verdict = "timeout";
  else if (run.status !== 0) verdict = "fail";
  else if (!(found >= gate.discover.min)) verdict = "incomplete (discovered " + found + ", need " + gate.discover.min + ")";
  console.log(`gate ${id}: ${verdict}${verdict === "pass" ? ` (${found} discovered)` : ""}`);
  if (verdict !== "pass") {
    failed = true;
    console.log(out.split("\n").slice(-25).join("\n"));
  }
}
process.exit(failed ? 1 : 0);
