// The page-load skill ships with Next.js projects only and is routed from the entry points.
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
const skillPath = ".agents/skills/page-load";

function render({ lean, next }) {
  const target = mkdtempSync(join(tmpdir(), "page-load-"));
  const answers = { ...base, flags: { ...base.flags, LEAN: lean, HAS_UI: true, NEXTJS: next } };
  const answersFile = join(target, "answers.json");
  writeFileSync(answersFile, JSON.stringify(answers));
  const run = spawnSync(process.execPath, [scaffold, "--answers", answersFile, "--target", target], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return target;
}

for (const lean of [false, true]) {
  test(`page-load skill is Next.js-gated and routed (lean=${lean})`, () => {
    const target = render({ lean, next: true });
    const other = render({ lean, next: false });
    assert.ok(!existsSync(join(other, skillPath)), "non-Next projects must not include the skill");
    assert.doesNotMatch(readFileSync(join(other, "AGENTS.md"), "utf8"), /page-load/);
    assert.match(readFileSync(join(target, "AGENTS.md"), "utf8"), /page-load\/SKILL\.md/);
    const skill = readFileSync(join(target, skillPath, "SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: page-load\n/);
    assert.match(skill, /references\/patterns\.md/);
    assert.doesNotMatch(skill, /\{\{/);
    assert.ok(existsSync(join(target, skillPath, "references/patterns.md")));
    assert.match(readFileSync(join(target, ".agents/skills-index.md"), "utf8"), /page-load/);
    assert.ok(lstatSync(join(target, ".claude/skills/page-load")).isSymbolicLink());
  });
}
