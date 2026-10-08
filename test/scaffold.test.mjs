// M0 characterization: renderer, dry-run, no-overwrite, invalid input, sync, docs-check.
// Run: node --test 'test/*.test.mjs'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const scaffold = join(root, "project-setup/scripts/scaffold.mjs");
const answersPath = join(root, "test/fixtures/answers.json");
const tmp = () => mkdtempSync(join(tmpdir(), "scaffold-"));
const run = (args) => spawnSync(process.execPath, [scaffold, ...args], { encoding: "utf8" });

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function answers(patch) {
  const base = JSON.parse(readFileSync(answersPath, "utf8"));
  const merged = { ...base, ...patch, vars: { ...base.vars, ...patch.vars } };
  const file = join(tmp(), "answers.json");
  writeFileSync(file, JSON.stringify(merged));
  return file;
}

test("render is reproducible", () => {
  const a = tmp(),
    b = tmp();
  assert.equal(run(["--answers", answersPath, "--target", a]).status, 0);
  assert.equal(run(["--answers", answersPath, "--target", b]).status, 0);
  assert.deepEqual(tree(a), tree(b));
});

test("dry-run writes nothing", () => {
  const t = tmp();
  const r = run(["--answers", answersPath, "--target", t, "--dry-run"]);
  assert.equal(r.status, 0);
  assert.deepEqual(readdirSync(t), []);
});

test("existing files are never overwritten without --force", () => {
  const t = tmp();
  run(["--answers", answersPath, "--target", t]);
  writeFileSync(join(t, "AGENTS.md"), "user edit\n");
  const r = run(["--answers", answersPath, "--target", t]);
  assert.equal(readFileSync(join(t, "AGENTS.md"), "utf8"), "user edit\n");
  assert.match(r.stdout, /skipped .* existing files/);
});

test("missing variable writes nothing", () => {
  const t = tmp();
  const r = run(["--answers", answers({ vars: { PROJECT_NAME: undefined } }), "--target", t]);
  assert.notEqual(r.status, 0);
  assert.deepEqual(readdirSync(t), []);
});

test("unsafe inputs are rejected", () => {
  for (const patch of [
    { vars: { CMD_LINT: 'a"b' } },
    { apps: [{ APP_DIR: "../escape" }] },
    { apps: [{ APP_DIR: "/abs" }] },
    { flags: { TYPESCRIPT: "yes" } },
  ]) {
    const t = tmp();
    const r = run(["--answers", answers(patch), "--target", t]);
    assert.notEqual(r.status, 0, JSON.stringify(patch));
    assert.deepEqual(readdirSync(t), [], JSON.stringify(patch));
  }
});

test("--sync keeps local edits when the template is unchanged", () => {
  const t = tmp();
  run(["--answers", answersPath, "--target", t]);
  writeFileSync(join(t, "AGENTS.md"), "user edit\n");
  const r = run(["--answers", answersPath, "--target", t, "--sync"]);
  assert.equal(r.status, 0);
  assert.equal(readFileSync(join(t, "AGENTS.md"), "utf8"), "user edit\n");
  assert.equal(existsSync(join(t, ".project-setup")), false);
});

test("--sync and --force are exclusive", () => {
  assert.notEqual(run(["--answers", answersPath, "--sync", "--force"]).status, 0);
});

const docsCheck = (dir, ...extra) =>
  spawnSync(process.execPath, [join(dir, "scripts/checks/docs-check.mjs"), "--root", dir, ...extra], {
    encoding: "utf8",
  });

test("docs-check fails on unfilled FILL markers", () => {
  const t = tmp();
  run(["--answers", answersPath, "--target", t]);
  assert.notEqual(docsCheck(t, "--strict").status, 0);
});

test("docs-check fails when a link target is broken", () => {
  const t = tmp();
  run(["--answers", answersPath, "--target", t]);
  writeFileSync(join(t, "docs", "broken.md"), "[x](./nope.md)\n");
  const r = docsCheck(t);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /broken\.md/);
});

test("docs-check on an empty root reports no Markdown scanned", () => {
  const r = spawnSync(
    process.execPath,
    [join(root, "project-setup/templates/scripts/checks/docs-check.mjs"), "--root", tmp()],
    { encoding: "utf8" },
  );
  assert.notEqual(r.status, 0, "an empty applicable scan must not pass");
});

test("fully-flagged render stays inside the AGENTS.md and context/README.md token budgets", () => {
  const t = tmp();
  const flags = { MONOREPO: true, HAS_UI: true, HAS_DB: true, HAS_AUTH: true, HAS_E2E: true };
  const vars = { AUTH_PACKAGE_PATTERNS: '"better-auth"', CMD_E2E: "npm run e2e" };
  assert.equal(run(["--answers", answers({ flags: { TYPESCRIPT: true, ...flags }, vars }), "--target", t]).status, 0);
  const r = spawnSync(process.execPath, [join(t, "scripts/checks/docs-check.mjs"), "--root", t], { encoding: "utf8" });
  assert.doesNotMatch(r.stdout + r.stderr, /budget/);
});
