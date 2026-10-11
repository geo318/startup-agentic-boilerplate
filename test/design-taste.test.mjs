// The long Taste Standard reference is installed but routed only for UI design planning.
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
const skillPath = ".agents/skills/design-taste";

function render({ lean, ui }) {
  const target = mkdtempSync(join(tmpdir(), "design-taste-"));
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
  test(`design taste is lazy and UI-gated (lean=${lean})`, () => {
    const target = render({ lean, ui: true });
    const nonUi = render({ lean, ui: false });
    assert.ok(!existsSync(join(nonUi, skillPath)), "backend-only projects must not include the design skill");
    const entry = readFileSync(join(target, "AGENTS.md"), "utf8");
    assert.match(entry, /design-taste\/SKILL\.md/);
    assert.doesNotMatch(entry, /Inline Image Typography|Perpetual Micro-Loops/);
    const skill = readFileSync(join(target, skillPath, "SKILL.md"), "utf8");
    assert.match(skill, /references\/DESIGN\.md/);
    assert.match(skill, /do not overwrite project UI tokens/i);
    assert.ok(existsSync(join(target, skillPath, "references/DESIGN.md")));
    assert.ok(existsSync(join(target, skillPath, "references/LICENSE")));
    const index = readFileSync(join(target, ".agents/skills-index.md"), "utf8");
    assert.match(index, /design-taste/);
    assert.doesNotMatch(index, /## 9\. Anti-Patterns/);
    assert.ok(lstatSync(join(target, ".claude/skills/design-taste")).isSymbolicLink());
  });
}
