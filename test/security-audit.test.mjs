// The security-audit skill and the security boundaries doc ship with the full preset, routed
// from the architecture router and the skills guide; the lean preset stays minimal.
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
const skill = ".agents/skills/security-audit";
const boundaries = "context/architecture/security.md";

function render(lean) {
  const target = mkdtempSync(join(tmpdir(), "security-audit-"));
  const answersFile = join(target, "answers.json");
  writeFileSync(answersFile, JSON.stringify({ ...base, flags: { ...base.flags, LEAN: lean } }));
  const run = spawnSync(process.execPath, [scaffold, "--answers", answersFile, "--target", target], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return target;
}
const read = (target, path) => readFileSync(join(target, path), "utf8");

test("the full preset ships the security audit, routed and checked", () => {
  const target = render(false);
  for (const file of [`${skill}/SKILL.md`, `${skill}/references/fixes.md`, boundaries]) {
    assert.ok(existsSync(join(target, file)), `missing ${file}`);
    assert.doesNotMatch(read(target, file), /\{\{[#/]?[A-Z!a-z]/, `unresolved template syntax in ${file}`);
  }
  // AGENTS.md sits at its token budget, so the routing lives in the docs it links to.
  assert.match(read(target, "context/architecture.md"), /\[Security boundaries\]\(architecture\/security\.md\)/);
  const guide = read(target, ".agents/README.md");
  assert.match(guide, /skills\/security-audit\/SKILL\.md/);
  assert.match(guide, /context\/architecture\/security\.md/);
  assert.match(read(target, ".agents/skills/review/SKILL.md"), /\/security-audit/);
  assert.match(read(target, ".agents/skills-index.md"), /security-audit/);
  assert.ok(lstatSync(join(target, ".claude/skills/security-audit")).isSymbolicLink());

  // docs-check treats it as a project skill: its links resolve; only FILL markers remain.
  const check = spawnSync(process.execPath, [join(target, "scripts/checks/docs-check.mjs"), "--root", target], {
    encoding: "utf8",
  });
  assert.doesNotMatch(check.stdout + check.stderr, /security-audit.*(broken|missing)|broken link.*security/i);
});

test("the skill reports before it fixes and keeps fixes out of the default read", () => {
  const body = readFileSync(join(root, "project-setup/templates", skill, "SKILL.md"), "utf8");
  assert.match(body, /^name: security-audit$/m);
  assert.match(body, /Fix nothing unless asked/);
  assert.match(body, /"not covered",\s+never a pass/);
  assert.match(body, /\[fixes\]\(references\/fixes\.md\) only when asked to fix/);
  assert.match(body, /never production/);
  assert.match(body, /Never print a value/);
});

test("the lean preset does not ship the security audit", () => {
  const target = render(true);
  assert.ok(!existsSync(join(target, skill)));
  assert.ok(!existsSync(join(target, boundaries)));
  assert.doesNotMatch(read(target, "AGENTS.md"), /security-audit|architecture\/security\.md/);
});

test("the catalogs name the skill and the boundary invariants", () => {
  const invariants = readFileSync(join(root, "project-setup/references/invariants-catalog.md"), "utf8");
  for (const id of ["D9", "D10", "D11", "D12", "D13", "D14", "D15", "O4"]) {
    assert.match(invariants, new RegExp(`^\\| ${id} \\|`, "m"), `invariants catalog is missing ${id}`);
  }
  assert.match(invariants, /\/security-audit/);
  assert.match(readFileSync(join(root, "project-setup/references/skills-catalog.md"), "utf8"), /`security-audit`/);
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /`security-audit`/);
});
