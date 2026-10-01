// M0 fixtures: scaffold variants, sync/upgrade outcomes, installer, protection report.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const scaffold = join(root, "project-setup/scripts/scaffold.mjs");
const base = JSON.parse(readFileSync(join(root, "test/fixtures/answers.json"), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "var-"));
const sha = (t) => createHash("sha256").update(t).digest("hex");

function answers(patch = {}) {
  const a = { vars: { ...base.vars, ...patch.vars }, flags: { ...base.flags, ...patch.flags }, apps: patch.apps ?? base.apps };
  const f = join(tmp(), "a.json");
  writeFileSync(f, JSON.stringify(a));
  return f;
}
const render = (patch, extra = []) => {
  const t = tmp();
  const r = spawnSync(process.execPath, [scaffold, "--answers", answers(patch), "--target", t, ...extra], { encoding: "utf8" });
  return { t, r };
};
function files(dir, out = [], rel = "") {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    e.isDirectory() ? files(dir, out, p) : out.push(p);
  }
  return out;
}
const noLeftovers = (t) => {
  for (const f of files(t).filter((f) => /\.(md|json|ya?ml|mjs)$/.test(f))) {
    assert.doesNotMatch(readFileSync(join(t, f), "utf8"), /\{\{[#/]?[A-Z!a-z]/, `unresolved template syntax in ${f}`);
  }
};

const app = (dir) => ({ ...base.apps[0], APP_DIR: dir });
const variants = {
  "typescript + github (base)": { patch: {}, has: [".github/workflows/ci.yml", "biome.json"], hasNot: [] },
  "no github": { patch: { flags: { GITHUB: false } }, has: ["AGENTS.md"], hasNot: [".github", ".agents/routines"] },
  "non-typescript": { patch: { flags: { TYPESCRIPT: false } }, has: ["AGENTS.md"], hasNot: ["biome.json", "tsconfig.base.json", ".fallowrc.json"] },
  "monorepo (two apps)": { patch: { apps: [app("apps/web"), app("apps/api")] }, has: ["apps/web/AGENTS.md", "apps/api/AGENTS.md"], hasNot: [] },
  "docs-only (no apps, no claude)": { patch: { apps: [], flags: { CLAUDE_CODE: false } }, has: ["context/README.md"], hasNot: [".claude"] },
  "adopt existing project": { patch: { flags: { ADOPT: true } }, has: ["context/plans/adoption.md"], hasNot: [".fallowrc.json"] },
};
for (const [name, v] of Object.entries(variants)) {
  test(`variant renders cleanly: ${name}`, () => {
    const { t, r } = render(v.patch);
    assert.equal(r.status, 0, r.stderr);
    for (const f of v.has) assert.ok(existsSync(join(t, f)), `expected ${f}`);
    for (const f of v.hasNot) assert.ok(!existsSync(join(t, f)), `unexpected ${f}`);
    noLeftovers(t);
  });
}

test("lock records the generator and a deterministic templates hash", () => {
  const a = render({}), b = render({});
  const la = JSON.parse(readFileSync(join(a.t, "docs/archive/project-setup.lock.json"), "utf8"));
  const lb = JSON.parse(readFileSync(join(b.t, "docs/archive/project-setup.lock.json"), "utf8"));
  assert.match(la.$meta.templatesHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(la, lb);
});

test("upgrade (--sync): untouched file with a changed template is updated; edited+changed goes to merge dir", () => {
  const { t } = render({});
  const lockPath = join(t, "docs/archive/project-setup.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  // simulate "template changed since render": file holds old content whose hash the lock still records
  writeFileSync(join(t, "docs/README.md"), "old render\n");
  lock["docs/README.md"] = sha("old render\n");
  // simulate "user edited AND template changed": lock records some other old render
  writeFileSync(join(t, "docs/local-setup.md"), "my edits\n");
  lock["docs/local-setup.md"] = sha("an older render\n");
  writeFileSync(lockPath, JSON.stringify(lock));
  const r = spawnSync(process.execPath, [scaffold, "--answers", answers(), "--target", t, "--sync"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(readFileSync(join(t, "docs/README.md"), "utf8"), "old render\n");
  assert.equal(readFileSync(join(t, "docs/local-setup.md"), "utf8"), "my edits\n"); // user's file untouched
  assert.ok(existsSync(join(t, ".project-setup/sync/docs/local-setup.md")));
  assert.match(r.stdout, /merge 1 files/);
});

test("dry-run on an adopted project reports conflicts and writes nothing", () => {
  const { t } = render({});
  writeFileSync(join(t, "AGENTS.md"), "mine\n");
  const before = files(t).map((f) => [f, sha(readFileSync(join(t, f)))]);
  const r = spawnSync(process.execPath, [scaffold, "--answers", answers(), "--target", t, "--dry-run"], { encoding: "utf8" });
  assert.match(r.stdout, /= AGENTS\.md/);
  assert.deepEqual(files(t).map((f) => [f, sha(readFileSync(join(t, f)))]), before);
});

// ---------- installer ----------
const install = join(root, "install.sh");
const sh = (args, env = {}) => spawnSync("sh", [install, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("install.sh: project install copies; --link symlinks; reinstall refused; bad dir and no args fail", () => {
  const p = tmp();
  assert.equal(sh([p]).status, 0);
  assert.ok(existsSync(join(p, ".claude/skills/project-setup/SKILL.md")));
  assert.notEqual(sh([p]).status, 0);
  const l = tmp();
  assert.equal(sh([l, "--link"]).status, 0);
  assert.ok(lstatSync(join(l, ".claude/skills/project-setup")).isSymbolicLink());
  assert.notEqual(sh(["/nonexistent/dir"]).status, 0);
  assert.notEqual(sh([]).status, 0);
});

test("install.sh --global writes only under HOME", () => {
  const home = tmp();
  assert.equal(sh(["--global"], { HOME: home }).status, 0);
  assert.ok(existsSync(join(home, ".claude/skills/project-setup/SKILL.md")));
});

// ---------- repository protection report ----------
const protection = join(root, "project-setup/scripts/protection.mjs");
function fakeGh(script) {
  const d = tmp();
  writeFileSync(join(d, "gh"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(d, "gh"), 0o755);
  return { PATH: `${d}:${process.env.PATH}` };
}
const prot = (env, args = []) => spawnSync(process.execPath, [protection, "--repo", "o/r", "--branch", "main", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("protection: unprotected, protected, and unknown are distinct; --require fails unless protected", () => {
  const unprot = fakeGh(`case "$*" in *protection*) echo '{"message":"Branch not protected"}' >&2; exit 1;; *rules/branches*) echo '[]';; esac`);
  const r = prot(unprot);
  assert.match(r.stdout, /UNPROTECTED/);
  assert.equal(r.status, 0);
  assert.equal(prot(unprot, ["--require"]).status, 1);
  const ok = fakeGh(`case "$*" in *protection*) echo '{"required_status_checks":{"contexts":["ci"]}}';; *rules/branches*) echo '[]';; esac`);
  assert.match(prot(ok).stdout, /PROTECTED/);
  assert.equal(prot(ok, ["--require"]).status, 0);
  const rules = fakeGh(`case "$*" in *protection*) echo '{"message":"Not Found"}' >&2; exit 1;; *rules/branches*) echo '[{"type":"required_status_checks"}]';; esac`);
  assert.match(prot(rules).stdout, /PROTECTED/);
  const noaccess = fakeGh(`echo "HTTP 403" >&2; exit 1`);
  const u = prot(noaccess);
  assert.match(u.stdout, /UNKNOWN/);
  assert.equal(prot(noaccess, ["--require"]).status, 1);
});

// ---------- optional runtime (M7) ----------
const runtimeFlags = { flags: { AGENTIC_RUNTIME: true }, vars: { GATE_DISCOVER_REGEX: "# pass (\\d+)", CMD_TEST: "node --test" } };
const schemasDir = join(root, "schemas");

test("runtime disabled: no runtime files, skills carry no managed section", () => {
  const { t } = render({});
  for (const f of [".agents/policy.json", ".agents/models.example.json", "scripts/agentic.mjs", ".agents/skills/stats"]) assert.ok(!existsSync(join(t, f)), f);
  assert.doesNotMatch(readFileSync(join(t, "AGENTS.md"), "utf8"), /Managed workflow/);
  assert.doesNotMatch(readFileSync(join(t, ".agents/skills/architect/SKILL.md"), "utf8"), /Managed mode/);
});

test("runtime enabled: policy.json validates against the schema; launcher executable; skills delegate", async () => {
  const { t, r } = render(runtimeFlags);
  assert.equal(r.status, 0, r.stderr);
  const { validate } = await import("../packages/agent-runtime/src/schema.ts");
  const policy = JSON.parse(readFileSync(join(t, ".agents/policy.json"), "utf8"));
  assert.deepEqual(validate(JSON.parse(readFileSync(join(schemasDir, "policy.schema.json"), "utf8")), policy), []);
  assert.deepEqual(policy.gates[0].argv, ["node", "--test"]);
  assert.equal(policy.egress, "local-only");
  assert.ok(policy.protectedPaths.includes(".agents") && policy.protectedPaths.includes("package.json"));
  assert.ok((lstatSync(join(t, "scripts/agentic.mjs")).mode & 0o111) !== 0);
  assert.match(readFileSync(join(t, ".agents/skills/architect/SKILL.md"), "utf8"), /Managed mode/);
  assert.equal(policy.enabled, true); // the managed workflow is ON by default
  assert.match(readFileSync(join(t, "AGENTS.md"), "utf8"), /## Managed workflow[\s\S]*"enabled": true/);
  assert.ok(existsSync(join(t, ".agents/skills/stats/SKILL.md")));
  assert.match(readFileSync(join(t, ".agents/skills-index.md"), "utf8"), /stats/);
  noLeftovers(t);
});

test("runtime: hosted and docker options flow into policy; bad inputs refuse before writing", () => {
  const ok = render({ flags: { ...runtimeFlags.flags, AGENTIC_ALLOW_HOSTED: true }, vars: { ...runtimeFlags.vars, AGENTIC_DOCKER_IMAGE: "node:22-slim" } });
  const p = JSON.parse(readFileSync(join(ok.t, ".agents/policy.json"), "utf8"));
  assert.equal(p.egress, "hosted-allowed");
  assert.equal(p.dockerImage, "node:22-slim");
  for (const vars of [{ GATE_DISCOVER_REGEX: undefined }, { GATE_DISCOVER_REGEX: "no capture group" }, { GATE_DISCOVER_REGEX: "(unclosed" }, { AGENTIC_DOCKER_IMAGE: 'bad"image' }]) {
    const bad = render({ flags: runtimeFlags.flags, vars: { ...runtimeFlags.vars, ...vars } });
    assert.notEqual(bad.r.status, 0, JSON.stringify(vars));
    assert.deepEqual(readdirSync(bad.t), [], JSON.stringify(vars));
  }
});

test("enable the runtime later with --sync: adds files, leaves edited files alone, reports template change", () => {
  const { t } = render({});
  writeFileSync(join(t, "AGENTS.md"), "my edits\n");
  const r = spawnSync(process.execPath, [scaffold, "--answers", answers(runtimeFlags), "--target", t, "--sync"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(t, ".agents/policy.json")));
  assert.equal(readFileSync(join(t, "AGENTS.md"), "utf8"), "my edits\n");
  assert.match(r.stdout, /templates: (unchanged|changed)/);
});

// ---------- launcher + pin, end to end through real processes ----------

const { treeHash } = await import("../packages/agent-runtime/src/pin.ts");

function pinned() {
  const { t } = render(runtimeFlags);
  const rt = join(tmp(), "pkg", "agent-runtime");
  mkdirSync(join(rt, ".."), { recursive: true });
  cpSync(join(root, "packages/agent-runtime"), rt, { recursive: true, filter: (s) => !s.includes("node_modules") });
  cpSync(schemasDir, join(rt, "..", "..", "schemas"), { recursive: true });
  const r = spawnSync(process.execPath, [join(rt, "src/cli/main.ts"), "pin", "--project", t], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { t, rt };
}
const homes = new Map(); // one controller home per scaffolded project, never shared between tests
const homeOf = (t) => homes.get(t) ?? homes.set(t, tmp()).get(t);
const launch = (t, args, env = {}) =>
  spawnSync(process.execPath, [join(t, "scripts/agentic.mjs"), ...args], { encoding: "utf8", env: { ...process.env, AGENTIC_HOME: homeOf(t), ...env } });

test("pin and launcher compute the same tree hash", () => {
  const { t, rt } = pinned();
  const pin = JSON.parse(readFileSync(join(t, ".agents/runtime.json"), "utf8"));
  assert.equal(pin.treeHash, treeHash(rt));
  assert.equal(launch(t, ["doctor"]).status, 0);
});

test("launcher: refuses without a pin and when the runtime changed after pinning", () => {
  const bare = render(runtimeFlags).t;
  const none = launch(bare, ["doctor"]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no runtime pinned/);
  const { t, rt } = pinned();
  writeFileSync(join(rt, "src/risk.ts"), `${readFileSync(join(rt, "src/risk.ts"), "utf8")}\n// tampered\n`);
  const r = launch(t, ["doctor"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /differs from the pinned version/);
});

test("fresh scaffold → pin → create → run with a replay worker → awaiting acceptance; accept refused without a terminal", () => {
  const { t } = pinned();
  const home = homeOf(t);
  const h = createHash("sha256").update("bad").digest("hex");
  writeFileSync(join(t, "value.txt"), "bad");
  writeFileSync(join(t, "check.mjs"), `import {readFileSync} from "node:fs"; console.log("# pass 1"); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`);
  writeFileSync(join(t, "worker.json"), JSON.stringify([
    JSON.stringify({ id: "a", kind: "edit", edits: [{ kind: "replace", path: "value.txt", expectHash: h, find: "bad", replace: "good" }] }),
    JSON.stringify({ id: "b", kind: "finish" }),
  ]));
  writeFileSync(join(t, ".agents/models.json"), JSON.stringify({ schemaVersion: 1, profiles: { w: { kind: "replay", file: join(t, "worker.json") } }, roles: { worker: "w" } }));
  // the check script is the gate: point the generated policy's gate at it (a maintenance edit by the project owner)
  const pol = JSON.parse(readFileSync(join(t, ".agents/policy.json"), "utf8"));
  pol.gates[0].argv = ["node", "check.mjs"];
  pol.baseline = "off"; // this fixture starts red on purpose
  pol.protectedPaths.push("check.mjs");
  writeFileSync(join(t, ".agents/policy.json"), JSON.stringify(pol));
  const contract = join(t, "contract.json");
  writeFileSync(contract, JSON.stringify({ schemaVersion: 1, id: "fix-value", goal: "make value.txt say good", acceptance: ["check passes"], files: ["value.txt"], riskTier: "R1", budget: "narrow" }));
  const v = launch(t, ["validate", contract]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(launch(t, ["task", "create", contract]).status, 0);
  // the user's recorded decisions (what an interactive session would have written)
  mkdirSync(join(home, "tasks/fix-value/state"), { recursive: true });
  writeFileSync(join(home, "tasks/fix-value/state/isolation-consent.json"), JSON.stringify({ isolation: "none", decidedAt: "t" }));
  writeFileSync(join(home, "qualifications.json"), JSON.stringify([{ profileId: "mock/replay:worker.json", family: "action-protocol", source: "owner-declared", passed: true, detail: {}, at: "t" }]));
  const run = launch(t, ["task", "run", "fix-value"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /AWAITING_ACCEPTANCE/);
  const acc = launch(t, ["task", "accept", "fix-value"]); // stdin is not a terminal here
  assert.equal(acc.status, 3);
  assert.match(acc.stderr, /interactive terminal/);
  assert.equal(readFileSync(join(t, "value.txt"), "utf8"), "bad"); // the project tree was never touched
});

// ---------- trusted CI verifier ----------
const trusted = join(root, "project-setup/templates/scripts/checks/trusted-gates.mjs");
function ciRepo(policyOverride) {
  const d = tmp();
  const g = (...a) => spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  mkdirSync(join(d, ".agents"));
  writeFileSync(join(d, "tests.txt"), "test a\ntest b\n");
  writeFileSync(join(d, "check.mjs"), `import {readFileSync} from "node:fs"; const n=readFileSync("tests.txt","utf8").split("\\n").filter(l=>l.startsWith("test ")).length; console.log("tests "+n); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`);
  writeFileSync(join(d, "value.txt"), "good");
  const policy = { schemaVersion: 1, protectedPaths: [".agents", "check.mjs"], requiredGates: ["unit"], egress: "local-only", gates: [{ id: "unit", argv: ["node", "check.mjs"], timeoutMs: 20000, discover: { regex: "tests (\\d+)", min: 2 } }], ...policyOverride };
  writeFileSync(join(d, ".agents/policy.json"), JSON.stringify(policy));
  g("add", "-A"); g("commit", "-qm", "base");
  g("checkout", "-qb", "pr");
  return { d, g, policy };
}
const verify = (d, ...extra) => spawnSync(process.execPath, [trusted, "--base", "main", ...extra], { cwd: d, encoding: "utf8" });

test("trusted-gates: green change passes; failing test fails; deleted tests fail on discovery", () => {
  const { d, g } = ciRepo();
  assert.equal(verify(d).status, 0);
  writeFileSync(join(d, "value.txt"), "bad"); g("commit", "-qam", "break");
  assert.equal(verify(d).status, 1);
  writeFileSync(join(d, "value.txt"), "good"); writeFileSync(join(d, "tests.txt"), "test a\n"); g("commit", "-qam", "delete a test");
  const r = verify(d);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /incomplete \(discovered 1, need 2\)/);
});

test("trusted-gates: a PR that weakens the policy or the gate script cannot approve itself", () => {
  const { d, g, policy } = ciRepo();
  // the PR rewrites the policy to run `true` with no discovery requirement, and breaks the real behaviour
  writeFileSync(join(d, ".agents/policy.json"), JSON.stringify({ ...policy, gates: [{ id: "unit", argv: ["true"], timeoutMs: 1000, discover: { regex: ".", min: 0 } }] }));
  writeFileSync(join(d, "value.txt"), "bad");
  g("commit", "-qam", "weaken");
  const r = verify(d);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /protected paths changed/);
  const maint = verify(d, "--allow-protected-changes"); // even with the maintenance override the BASE gates still run
  assert.equal(maint.status, 1);
  assert.match(maint.stdout, /gate unit: fail/);
});

test("trusted-gates: replacing the gate script is caught; missing base policy fails closed", () => {
  const { d, g } = ciRepo();
  writeFileSync(join(d, "check.mjs"), `console.log("tests 99"); process.exit(0)`);
  g("commit", "-qam", "fake green");
  assert.match(verify(d).stderr, /protected paths changed/);
  const empty = tmp();
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: empty });
  writeFileSync(join(empty, "a"), "x");
  spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", "add", "-A"], { cwd: empty });
  spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", "commit", "-qm", "x"], { cwd: empty });
  const r = verify(empty);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /base branch must define the gates/);
});

test("runtime workflow: positive required check present, runs base policy, no secrets trigger; label stays a veto", () => {
  const { t } = render({ ...runtimeFlags });
  const wf = readFileSync(join(t, ".github/workflows/agentic-verify.yml"), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.match(wf, /pull_request:/);
  assert.doesNotMatch(wf, /pull_request_target/);
  assert.match(wf, /trusted-gates\.mjs --base origin\/main/);
  assert.ok(existsSync(join(t, ".github/workflows/merge-gate.yml")));
  assert.match(readFileSync(join(t, ".github/workflows/merge-gate.yml"), "utf8"), /do-not-merge/);
  const off = render({}).t;
  assert.ok(!existsSync(join(off, ".github/workflows/agentic-verify.yml")) && !existsSync(join(off, "scripts/checks/trusted-gates.mjs")));
});
