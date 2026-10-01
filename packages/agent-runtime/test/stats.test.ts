import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as c from "../src/cli/commands.ts";
import { EventLog } from "../src/events.ts";
import { canonical, sha256 } from "../src/hash.ts";
import { QualStore } from "../src/qualify.ts";
import { formatStats, summarizeTasks, type TaskStat } from "../src/stats.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "stats-"));
const t = (o: Partial<TaskStat>): TaskStat => ({
  id: "x",
  project: "/p",
  state: "AWAITING_ACCEPTANCE",
  tokens: 1000,
  costUsd: 0.02,
  unknownUsageCalls: 0,
  modelCalls: 2,
  repairs: 0,
  rejected: 0,
  accepted: false,
  verified: true,
  firstAttempt: true,
  wallMs: 10_000,
  ...o,
});

test("summary: cost per verified candidate counts ALL tasks; zero verified → undefined; timing only where it exists", () => {
  const s = summarizeTasks(
    [
      t({}),
      t({ id: "b", state: "ESCALATED", verified: false, firstAttempt: false, costUsd: 0.03, wallMs: null }),
      t({ id: "c", state: "ACCEPTED", accepted: true, repairs: 1, firstAttempt: false, wallMs: 30_000 }),
    ],
    "/p",
  );
  assert.equal(s.tasks, 3);
  assert.equal(s.verified, 2);
  assert.equal(s.firstAttemptVerified, 1);
  assert.equal(s.abstained, 1);
  assert.ok(Math.abs(s.costPerVerified! - 0.035) < 1e-9);
  assert.equal(s.timed, 2);
  assert.equal(s.medianWallMs, 30_000);
  const none = summarizeTasks([t({ verified: false, state: "BLOCKED", firstAttempt: false })], "/p");
  assert.equal(none.costPerVerified, null);
  assert.match(formatStats(none), /undefined \(no verified task\)/);
  assert.match(formatStats(s), /NOT measured: savings/); // never claims a saving it cannot measure
});

test("events carry timestamps; old logs without them still verify; tampering still detected", () => {
  const dir = tmp();
  const f = join(dir, "e.jsonl");
  const log = new EventLog(f).open();
  log.append("a", { x: 1 });
  log.append("b", {});
  log.close();
  const ev = new EventLog(f).read();
  assert.ok(ev.every((e) => /^\d{4}-/.test(e.ts!)));
  new EventLog(f).verify();
  // an old-format log (no ts, hash over the old body) must still verify
  const old = join(dir, "old.jsonl");
  const body = { seq: 0, prev: "", type: "state", data: { to: "X" } };
  writeFileSync(old, `${JSON.stringify({ ...body, hash: sha256(canonical(body)) })}\n`);
  new EventLog(old).verify();
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  writeFileSync(f, `${lines[0]!.replace(/"ts":"[^"]+"/, '"ts":"2000-01-01T00:00:00.000Z"')}\n${lines[1]}\n`);
  assert.throws(() => new EventLog(f).verify(), /corrupt/);
});

test("stats from real task runs: scoped to the repo, --since filters, --all spans repos, nothing invented", async () => {
  const home = tmp();
  const mkProject = () => {
    const project = tmp();
    mkdirSync(join(project, ".agents"));
    writeFileSync(join(project, "value.txt"), "bad");
    writeFileSync(
      join(project, ".agents/policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        protectedPaths: [],
        baseline: "off",
        egress: "local-only",
        gates: [
          {
            id: "g",
            argv: ["node", "-e", "console.log('tests 1')"],
            timeoutMs: 5000,
            discover: { regex: "tests (\\d+)", min: 1 },
          },
        ],
        requiredGates: ["g"],
      }),
    );
    writeFileSync(join(project, "ok.json"), JSON.stringify([JSON.stringify({ id: "x", kind: "finish" })]));
    writeFileSync(
      join(project, "stop.json"),
      JSON.stringify([JSON.stringify({ id: "x", kind: "blocked", reason: "stop" })]),
    );
    return project;
  };
  new QualStore(join(home, "qualifications.json")).record({
    profileId: "mock/replay:ok.json",
    family: "action-protocol",
    source: "owner-declared",
    passed: true,
    detail: {},
    at: "t",
  });
  new QualStore(join(home, "qualifications.json")).record({
    profileId: "mock/replay:stop.json",
    family: "action-protocol",
    source: "owner-declared",
    passed: true,
    detail: {},
    at: "t",
  });
  const run = async (project: string, id: string, script: string) => {
    writeFileSync(
      join(project, ".agents/models.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: { w: { kind: "replay", file: join(project, script) } },
        roles: { worker: "w" },
      }),
    );
    const out: string[] = [];
    const env: c.Env = {
      home,
      project,
      out: (s) => out.push(s),

      user: "u",
    };
    const f = join(tmp(), "c.json");
    writeFileSync(
      f,
      JSON.stringify({
        schemaVersion: 1,
        id,
        goal: "do the thing",
        acceptance: ["done"],
        files: ["value.txt"],
        riskTier: "R1",
        budget: "narrow",
      }),
    );
    await c.taskCreate(env, f);
    await c.taskRun(env, id);
    return env;
  };
  const a = mkProject(),
    b = mkProject();
  const envA = await run(a, "task-ok", "ok.json");
  await run(a, "task-stop", "stop.json");
  const envB = await run(b, "other-repo", "ok.json");
  const out: string[] = [];
  await c.stats({ ...envA, out: (s) => out.push(s) }, { json: true });
  const s = JSON.parse(out.join(""));
  assert.equal(s.tasks, 2);
  assert.equal(s.verified, 1);
  assert.equal(s.abstained, 1);
  assert.equal(s.timed, 2); // both runs have timestamps
  assert.ok(s.medianWallMs >= 0);
  const all: string[] = [];
  await c.stats({ ...envB, out: (x) => all.push(x) }, { all: true, json: true });
  assert.equal(JSON.parse(all.join("")).tasks, 3);
  const none: string[] = [];
  await c.stats({ ...envA, out: (x) => none.push(x) }, { since: "2099-01-01", json: true });
  assert.equal(JSON.parse(none.join("")).tasks, 0);
  await assert.rejects(c.stats(envA, { since: "yesterday-ish" }), /--since/);
});

test("stats report Jev shadow vs acted decisions, uncalibrated acts, and per-family counts", async () => {
  const { summarizeTasks, formatStats } = await import("../src/stats.ts");
  const rows = [
    { taskId: "t", qid: "a", family: "workflow-select", mode: "shadow", source: "rules", fallbackReason: "shadow" },
    { taskId: "t", qid: "b", family: "workflow-select", mode: "enabled", source: "jev", uncalibrated: true },
    { taskId: "t", qid: "c", family: "skill-select", mode: "shadow", source: "rules", fallbackReason: "shadow" },
  ];
  const s = summarizeTasks([{ id: "t", state: "BLOCKED" } as any], "x", rows);
  assert.equal(s.jev.shadow, 2);
  assert.equal(s.jev.acted, 1);
  assert.equal(s.jev.actedUncalibrated, 1);
  assert.deepEqual(s.jev.byFamily["workflow-select"], { decisions: 2, acted: 1 });
  assert.match(formatStats(s), /2 shadow-only, 1 acted on, 1 before calibration/);
});
