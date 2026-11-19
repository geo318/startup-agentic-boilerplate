// The request-cost rules are hard defaults: every project with a database states them in
// AGENTS.md and ships the data-access-audit skill; Next.js projects also get the no-waterfall rule.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scaffold = join(root, "project-setup/scripts/scaffold.mjs");
const base = JSON.parse(readFileSync(join(root, "test/fixtures/answers.json"), "utf8"));
const skill = ".agents/skills/data-access-audit";

function render(flags) {
  const target = mkdtempSync(join(tmpdir(), "data-access-audit-"));
  const answersFile = join(target, "answers.json");
  writeFileSync(answersFile, JSON.stringify({ ...base, flags: { ...base.flags, ...flags } }));
  const run = spawnSync(process.execPath, [scaffold, "--answers", answersFile, "--target", target], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return target;
}
const read = (target, path) => readFileSync(join(target, path), "utf8");
const full = { HAS_DB: true, HAS_UI: true, NEXTJS: true };

test("a project with a database states the request-cost rules and ships the audit", () => {
  const target = render(full);
  for (const file of [`${skill}/SKILL.md`, `${skill}/references/probes.md`, `${skill}/references/fixes.md`]) {
    assert.ok(existsSync(join(target, file)), `missing ${file}`);
    assert.doesNotMatch(read(target, file), /\{\{[#/]?[A-Z!a-z]/, `unresolved template syntax in ${file}`);
  }
  const agents = read(target, "AGENTS.md");
  assert.match(agents, /Request cost: one read transaction per request, no query in a loop/);
  assert.match(agents, /No request waterfalls/);
  const database = read(target, "context/standards/database.md");
  assert.match(database, /^## Request cost$/m);
  assert.match(database, /Never call a\s+repository in a loop over ids/);
  assert.match(read(target, "context/standards/react.md"), /`staleTime` is never `0`/);
  assert.match(read(target, ".agents/README.md"), /skills\/data-access-audit\/SKILL\.md/);
  assert.match(read(target, ".agents/skills/review/SKILL.md"), /\/data-access-audit/);
  assert.match(read(target, ".agents/skills-index.md"), /data-access-audit/);
  assert.ok(lstatSync(join(target, ".claude/skills/data-access-audit")).isSymbolicLink());

  // AGENTS.md stays inside its budget, and the skill's links resolve.
  const check = spawnSync(process.execPath, [join(target, "scripts/checks/docs-check.mjs"), "--root", target], {
    encoding: "utf8",
  });
  const output = check.stdout + check.stderr;
  assert.doesNotMatch(output, /AGENTS\.md.*(token|line) budget/i);
  assert.doesNotMatch(output, /data-access-audit.*(broken|missing)|broken link.*(data-access|request-cost)/i);
});

test("the skill measures before judging and keeps fixes out of the default read", () => {
  const body = readFileSync(join(root, "project-setup/templates", skill, "SKILL.md"), "utf8");
  assert.match(body, /^name: data-access-audit$/m);
  assert.match(body, /fixes nothing unless asked/);
  assert.match(body, /"Not covered",\s+never a pass/);
  assert.match(body, /\[fixes\]\(references\/fixes\.md\) only when asked to fix/);
  assert.match(body, /whole integration suite/);
});

test("without a database the rules and the skill stay out", () => {
  const target = render({ HAS_DB: false, HAS_UI: false, NEXTJS: false });
  assert.ok(!existsSync(join(target, skill)));
  assert.doesNotMatch(read(target, "AGENTS.md"), /Request cost|data-access-audit|waterfalls/);
});

test("the lean preset states the rules without the skill", () => {
  const target = render({ ...full, LEAN: true });
  assert.ok(!existsSync(join(target, skill)));
  const agents = read(target, "AGENTS.md");
  assert.match(agents, /Request cost: one read transaction per request/);
  assert.match(agents, /No request waterfalls/);
  assert.doesNotMatch(agents, /data-access-audit/);
});

test("the catalogs name the skill and the request-cost invariants", () => {
  const invariants = readFileSync(join(root, "project-setup/references/invariants-catalog.md"), "utf8");
  for (const id of ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "U9", "O5", "O6"]) {
    assert.match(invariants, new RegExp(`^\\| ${id} \\|`, "m"), `invariants catalog is missing ${id}`);
  }
  assert.match(invariants, /hard defaults/);
  assert.match(readFileSync(join(root, "project-setup/references/intake.md"), "utf8"), /hard defaults/);
  assert.match(readFileSync(join(root, "project-setup/references/skills-catalog.md"), "utf8"), /`data-access-audit`/);
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /`data-access-audit`/);
});
