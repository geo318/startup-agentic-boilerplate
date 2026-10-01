import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prSummary, readSessions, sessionCheck } from "../src/session.ts";
import { formatStats, summarizeTasks } from "../src/stats.ts";

const sh = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd });
function repo() {
  const project = mkdtempSync(join(tmpdir(), "sess-p-"));
  const home = mkdtempSync(join(tmpdir(), "sess-h-"));
  sh(project, "init", "-q", "-b", "feat/x");
  sh(project, "config", "user.email", "t@t");
  sh(project, "config", "user.name", "t");
  writeFileSync(join(project, "value.txt"), "good");
  writeFileSync(
    join(project, "check.mjs"),
    `import {readFileSync} from "node:fs"; console.log("tests 2"); process.exit(readFileSync("value.txt","utf8")==="good"?0:1)`,
  );
  sh(project, "add", "-A");
  sh(project, "commit", "-qm", "init");
  const gates = [
    { id: "unit", argv: ["node", "check.mjs"], timeoutMs: 5000, discover: { regex: "tests (\\d+)", min: 1 } },
  ];
  const out: string[] = [];
  const check = () => sessionCheck({ home, project, gates, requiredGates: ["unit"], out: (s) => out.push(s) });
  return { project, home, out, check };
}

test("session check: clean tree and docs-only changes run nothing; a failing change returns 2 with the diagnostic; an unchanged re-check reuses the row", async () => {
  const r = repo();
  assert.equal(await r.check(), 0);
  writeFileSync(join(r.project, "NOTES.md"), "x");
  assert.equal(await r.check(), 0);
  assert.equal(readSessions(r.home).length, 0);
  writeFileSync(join(r.project, "value.txt"), "bad");
  assert.equal(await r.check(), 2);
  assert.match(r.out.join("\n"), /gate unit: fail/);
  assert.equal(await r.check(), 2); // same bytes: no second gate run
  assert.equal(readSessions(r.home).length, 1);
  writeFileSync(join(r.project, "value.txt"), "good");
  assert.equal(await r.check(), 0); // tree equals HEAD again: nothing to test
  writeFileSync(join(r.project, "extra.txt"), "new file");
  assert.equal(await r.check(), 0);
  const rows = readSessions(r.home);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.passed, true);
  assert.equal(rows[1]!.branch, "feat/x");
});

test("session check: a gate that rewrites the tree does not pass", async () => {
  const r = repo();
  writeFileSync(
    join(r.project, "check.mjs"),
    `import {writeFileSync} from "node:fs"; writeFileSync("value.txt","changed"); console.log("tests 2")`,
  );
  assert.equal(await r.check(), 2);
  assert.match(r.out.join("\n"), /modified the working tree/);
});

test("pr summary and stats report the recorded checks, and claim no savings", async () => {
  const r = repo();
  writeFileSync(join(r.project, "value.txt"), "bad");
  await r.check();
  writeFileSync(join(r.project, "value.txt"), "good");
  writeFileSync(join(r.project, "extra.txt"), "new file");
  await r.check();
  const md = prSummary(r.home, r.project);
  assert.match(md, /2 \(1 passed, 1 failed\)/);
  assert.match(md, /Latest: passed/);
  assert.match(formatStats(summarizeTasks([], "x", [], undefined, readSessions(r.home))), /2 \(1 passed, 1 failed\)/);
  assert.match(prSummary(r.home, mkdtempSync(join(tmpdir(), "sess-none-"))), /No automatic gate checks/);
});

test("session check verifies committed branch changes and records a failing gate", async () => {
  const r = repo();
  sh(r.project, "branch", "main");
  writeFileSync(join(r.project, "value.txt"), "bad");
  sh(r.project, "add", "-A");
  sh(r.project, "commit", "-qm", "break value");
  assert.equal(await r.check(), 2);
  assert.equal(readSessions(r.home).length, 1);
  assert.equal(readSessions(r.home)[0]!.changed, 1);
  assert.equal(await r.check(), 2);
  assert.equal(readSessions(r.home).length, 1);
});
