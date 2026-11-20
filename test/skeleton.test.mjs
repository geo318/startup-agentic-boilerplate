// The skeleton skill ships with UI projects only, routed from the entry points with its invariant.
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
const skillPath = ".agents/skills/skeleton";

function render({ lean, ui }) {
  const target = mkdtempSync(join(tmpdir(), "skeleton-"));
  const answers = { ...base, flags: { ...base.flags, LEAN: lean, HAS_UI: ui } };
  const answersFile = join(target, "answers.json");
  writeFileSync(answersFile, JSON.stringify(answers));
  const run = spawnSync(process.execPath, [scaffold, "--answers", answersFile, "--target", target], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return target;
}

for (const lean of [false, true]) {
  test(`skeleton skill is UI-gated, routed and stated as an invariant (lean=${lean})`, () => {
    const target = render({ lean, ui: true });
    const other = render({ lean, ui: false });
    assert.ok(!existsSync(join(other, skillPath)), "projects without UI must not include the skill");
    assert.doesNotMatch(readFileSync(join(other, "AGENTS.md"), "utf8"), /skeleton/);
    const entry = readFileSync(join(target, "AGENTS.md"), "utf8");
    assert.match(entry, /skeleton\/SKILL\.md/);
    assert.match(entry, /Loading states are the page/);
    const skill = readFileSync(join(target, skillPath, "SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: skeleton\n/);
    assert.match(skill, /## 6\. Verify against the loaded page/);
    assert.doesNotMatch(skill, /\{\{|## In this project/);
    assert.match(readFileSync(join(target, ".agents/skills-index.md"), "utf8"), /skeleton/);
    assert.ok(lstatSync(join(target, ".claude/skills/skeleton")).isSymbolicLink());
  });
}
