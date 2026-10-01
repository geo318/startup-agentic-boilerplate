// M0 fixtures: scaffold variants, sync/upgrade outcomes, installer, protection report.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
