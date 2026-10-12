import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, lstatSync, readlinkSync, rmSync } from "node:fs";
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

test("install links to the skill in node_modules when it is a dependency", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  cpSync(new URL("../project-setup", import.meta.url).pathname, join(dir, "node_modules/@geo318/agentic-boilerplate/project-setup"), { recursive: true });
  assert.equal(run("install", dir).status, 0);
  assert.equal(readlinkSync(join(dir, ".agents/skills/project-setup")), "../../node_modules/@geo318/agentic-boilerplate/project-setup");
  assert.ok(existsSync(join(dir, ".claude/skills/project-setup/SKILL.md")));
  rmSync(join(dir, "node_modules"), { recursive: true });
  const index = new URL("../project-setup/templates/scripts/skills/index.mjs", import.meta.url).pathname;
  assert.equal(spawnSync(process.execPath, [index, "--root", dir], { encoding: "utf8" }).status, 0, "dangling link before npm install");
});

test("--global copies even when the home directory has the package installed", () => {
  const home = mkdtempSync(join(tmpdir(), "cli-"));
  cpSync(new URL("../project-setup", import.meta.url).pathname, join(home, "node_modules/@geo318/agentic-boilerplate/project-setup"), { recursive: true });
  assert.equal(spawnSync(process.execPath, [cli, "install", "--global"], { encoding: "utf8", env: { ...process.env, HOME: home } }).status, 0);
  assert.ok(!lstatSync(join(home, ".agents/skills/project-setup")).isSymbolicLink());
});

test("sync fails outside a project-setup project", () => {
  assert.notEqual(run("sync", mkdtempSync(join(tmpdir(), "cli-"))).status, 0);
});
