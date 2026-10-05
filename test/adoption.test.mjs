import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

test("documented changed-file lint preserves filenames, skips empty changes, and propagates failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "adoption-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "with space.ts"), "initial\n");
  git("add", ".");
  git("commit", "-m", "initial");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const guide = readFileSync(new URL("../project-setup/references/adopt.md", import.meta.url), "utf8");
  const script = join(dir, "lint-changed.mjs");
  writeFileSync(script, guide.match(/```js\n([\s\S]*?)\n```/)[1]);
  const bin = join(repo, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "calls.jsonl");
  for (const name of ["biome", "oxlint"]) {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.LINT_LOG, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + "\\n");\nprocess.exit(Number(process.env.LINT_EXIT || 0));\n`);
    chmodSync(path, 0o755);
  }
  const run = (exit = "0") => spawnSync(process.execPath, [script], {
    cwd: repo, encoding: "utf8",
    env: { ...process.env, PATH: bin + delimiter + process.env.PATH, LINT_LOG: log, LINT_EXIT: exit },
  });
  assert.equal(run().status, 0);
  assert.equal(existsSync(log), false, "no files must not invoke a whole-repo lint");
  writeFileSync(join(repo, "with space.ts"), "changed\n");
  writeFileSync(join(repo, "new.ts"), "untracked\n");
  assert.equal(run("7").status, 7);
  let calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, [["biome", "check", "./with space.ts", "./new.ts"]]);
  assert.equal(run().status, 0);
  calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.at(-1), ["oxlint", "./with space.ts", "./new.ts"]);
  git("update-ref", "-d", "refs/remotes/origin/main");
  assert.notEqual(run().status, 0, "missing base must fail rather than silently skip checks");
});
