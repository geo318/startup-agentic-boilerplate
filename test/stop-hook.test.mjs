import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../project-setup/templates/scripts/checks/agent-stop.mjs", import.meta.url));

for (const defaultBranch of ["main", "trunk"]) test(`Stop hook checks committed changes based on ${defaultBranch}`, () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-hook-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], {
      cwd: dir, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q", "-b", defaultBranch);
  const renderedHook = join(dir, "stop.mjs");
  writeFileSync(renderedHook, readFileSync(hook, "utf8").replaceAll("{{DEFAULT_BRANCH}}", defaultBranch));
  mkdirSync(join(dir, "scripts/checks"), { recursive: true });
  writeFileSync(join(dir, "scripts/checks/docs-check.mjs"), 'console.error("broken documentation"); process.exit(1);\n');
  git("add", ".");
  git("commit", "-qm", "fixture");
  const run = (payload = {}) => spawnSync(process.execPath, [renderedHook], {
    cwd: dir, input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.equal(run().status, 0, "unchanged base needs no checks");
  git("checkout", "-qb", "feat/docs");
  writeFileSync(join(dir, "README.md"), "changed docs\n");
  git("add", ".");
  git("commit", "-qm", "change docs");
  assert.equal(git("status", "--porcelain"), "");
  const result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /broken documentation/);
  assert.equal(run({ stop_hook_active: true }).status, 0, "failed check does not loop indefinitely");
});
