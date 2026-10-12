import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("../bin/cli.mjs", import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("install copies the skill, refuses to overwrite, and --force replaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  assert.equal(run("install", dir).status, 0);
  assert.ok(existsSync(join(dir, ".agents/skills/project-setup/SKILL.md")));
  assert.ok(existsSync(join(dir, ".claude/skills/project-setup/SKILL.md")));
  assert.notEqual(run("install", dir).status, 0);
  assert.equal(run("install", dir, "--force").status, 0);
});

test("sync fails outside a project-setup project", () => {
  assert.notEqual(run("sync", mkdtempSync(join(tmpdir(), "cli-"))).status, 0);
});
