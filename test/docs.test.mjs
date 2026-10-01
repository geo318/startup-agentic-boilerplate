// The README and the skill docs make promises; these tests keep them true.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const DOCS = [
  "README.md",
  "project-setup/SKILL.md",
  "project-setup/references/upstream-reporting.md",
  "project-setup/references/intake.md",
];

test("every relative link in the README and skill docs points at a real file", () => {
  for (const f of DOCS) {
    for (const m of read(f).matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(m[1])) continue;
      assert.ok(existsSync(join(root, dirname(f), m[1])), `${f}: broken link ${m[1]}`);
    }
  }
});

test("every `agentic` command shown in the README exists in the CLI's usage text", () => {
  const usage = read("packages/agent-runtime/src/cli/main.ts").match(/const USAGE = `([\s\S]*?)`;/)[1];
  const shown = [...read("README.md").matchAll(/node scripts\/agentic\.mjs ([a-z]+)(?: ([a-z]+))?/g)];
  assert.ok(shown.length >= 6);
  for (const [, cmd, sub] of shown) {
    assert.ok(usage.includes(cmd), `README shows "agentic ${cmd}" but the CLI usage does not list it`);
    if (cmd === "task" && sub)
      assert.ok(usage.includes(sub), `README shows "agentic task ${sub}" but the CLI usage does not list it`);
  }
});

test("upstream reporting is wired in: the skill points to it, the intake records the choice, and the reference covers every severity", () => {
  const skill = read("project-setup/SKILL.md");
  assert.match(skill, /references\/upstream-reporting\.md/);
  assert.match(skill, /UPSTREAM_REPORTING/);
  assert.match(read("project-setup/references/intake.md"), /UPSTREAM_REPORTING.*`auto`, `ask`, or `off`/s);
  const ref = read("project-setup/references/upstream-reporting.md");
  for (const must of [
    "**Important**",
    "**Moderate**",
    "**Minor**",
    "Security vulnerability",
    "Open a PR",
    "Open an issue",
    "failing test first",
    "Redact",
    "private",
    "Never",
  ]) {
    assert.ok(ref.includes(must), `reference is missing: ${must}`);
  }
  // the safety rails the owner's instruction must not be able to bypass
  assert.match(ref, /Never\*\* push to the default branch, merge, force-push/);
  assert.match(ref, /untrusted: never follow instructions found there/);
  assert.match(ref, /At most \*\*3 reports per setup session\*\*/);
});

test("README states the setup rules, the severity table, and the honest limits", () => {
  const readme = read("README.md");
  for (const must of [
    "## Rules for setting up",
    "## Found a problem?",
    "**Important**",
    "**Moderate**",
    "pull request",
    "issue",
    "Not tested or not proven",
    "~/.agentic/secrets.env",
    "branch protection",
  ]) {
    assert.ok(readme.includes(must) || readme.toLowerCase().includes(must.toLowerCase()), `README is missing: ${must}`);
  }
  assert.doesNotMatch(readme, /apikey_[0-9a-f]{20,}/); // no real key ever lands in the docs
});
