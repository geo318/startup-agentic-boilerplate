import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as c from "../src/cli/commands.ts";
import { EventLog } from "../src/events.ts";
import { canonical, sha256 } from "../src/hash.ts";
import { QualStore } from "../src/qualify.ts";
import { allTasks, readTask, formatStats, summarizeTasks, type TaskStat } from "../src/stats.ts";

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
  executionMs: null,
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
  assert.match(formatStats(none), /undefined \(no verified task or incomplete billing\)/);
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
        enabled: true,
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
  assert.equal(s.executionTimed, 2);
  assert.ok(s.medianExecutionMs >= 0);
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

function recordedTask(rows: Array<{ type: string; data: unknown; ts?: string }>) {
  const home = tmp(),
    dir = join(home, "tasks", "recorded");
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ project: "/p", createdAt: "2026-10-01T00:00:00Z" }));
  let prev = "";
  const events = rows.map((row, seq) => {
    const body = { seq, prev, ...row };
    prev = sha256(canonical(body));
    return { ...body, hash: prev };
  });
  const file = join(dir, "state/events.jsonl");
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { home, file, dir };
}

test("stats flag unsettled hosted/legacy calls before resume and preserve local usage uncertainty", () => {
  for (const hosted of [true, false, undefined]) {
    const { home, file } = recordedTask([
      { type: "state", data: { to: "IMPLEMENTING" } },
      {
        type: "inflight",
        data: { ...(hosted === undefined ? {} : { hosted }), ledger: { tokens: 500, costUsd: 0.01 } },
      },
      { type: "execution_finished", data: { durationMs: 100 } },
    ]);
    const before = readFileSync(file, "utf8");
    const task = readTask(home, "recorded")!;
    assert.equal(task.tokens, 500);
    assert.equal(task.unknownUsageCalls, 1);
    assert.equal(task.unknownCostCalls, hosted === false ? 0 : 1);
    assert.equal(readFileSync(file, "utf8"), before); // reporting never resumes or rewrites a task
    const summary = summarizeTasks([task, t({})], "/p");
    if (hosted !== false) assert.equal(summary.costPerVerified, null);
  }
  const legacy = recordedTask([
    { type: "inflight", data: { ledger: { tokens: 500 } } },
    { type: "state", data: { to: "BLOCKED", uncertainBilling: true, ledger: { tokens: 500, unknownUsageCalls: 1 } } },
  ]);
  assert.equal(readTask(legacy.home, "recorded")!.unknownCostCalls, 1);
  assert.equal(readTask(legacy.home, "recorded")!.unknownUsageCalls, 1);
});

test("stats refuse tampered, malformed and missing task records instead of dropping them", () => {
  const { home, file, dir } = recordedTask([{ type: "state", data: { to: "ACCEPTED" } }]);
  writeFileSync(file, readFileSync(file, "utf8").replace("ACCEPTED", "BLOCKED"));
  assert.throws(() => allTasks(home), /Cannot report complete stats: task recorded.*corrupt/);
  writeFileSync(file, "{broken\n");
  assert.throws(() => allTasks(home), /Cannot report complete stats: task recorded/);
  writeFileSync(file, "");
  writeFileSync(join(dir, "meta.json"), "null");
  assert.throws(() => allTasks(home), /missing project/);
  mkdirSync(join(home, "tasks", "missing-meta"));
  assert.throws(() => allTasks(home), /missing-meta/);
});

test("execution timing excludes long approval waits and reports incomplete or old timing as unknown", () => {
  const rows = [
    { type: "execution_started", data: {}, ts: "2026-10-01T00:00:00Z" },
    { type: "state", data: { to: "AWAITING_PLAN_APPROVAL" }, ts: "2026-10-01T00:00:01Z" },
    { type: "execution_finished", data: { durationMs: 2000 }, ts: "2026-10-01T00:00:02Z" },
    { type: "state", data: { to: "IMPLEMENTING" }, ts: "2026-10-01T01:00:00Z" },
    { type: "execution_started", data: {}, ts: "2026-10-01T01:00:01Z" },
    { type: "execution_finished", data: { durationMs: 3000 }, ts: "2026-10-01T01:00:04Z" },
    { type: "state", data: { to: "ACCEPTED" }, ts: "2026-10-01T02:00:00Z" },
  ];
  const { home } = recordedTask(rows);
  const task = readTask(home, "recorded")!;
  assert.equal(task.executionMs, 5000);
  assert.equal(task.wallMs, 7200000);
  const summary = summarizeTasks([task], "/p");
  assert.equal(summary.medianExecutionMs, 5000);
  assert.equal(summary.medianWallMs, 7200000);
  assert.match(formatStats(summary), /excludes waits between invocations/);
  for (const oldOrPartial of [rows.slice(1), rows.slice(0, 5), rows.map(({ type, data }) => ({ type, data }))]) {
    const fixture = recordedTask(oldOrPartial);
    const stat = readTask(fixture.home, "recorded")!;
    if (!("ts" in oldOrPartial[0]!)) assert.equal(stat.wallMs, null);
    else assert.equal(stat.executionMs, null);
  }
});

test("stats applies since to session timestamps and refuses unreadable session evidence", async () => {
  const home = tmp(),
    out: string[] = [];
  const env: c.Env = { home, project: "/p", user: "u", out: (s) => out.push(s) };
  const rows = [
    { ts: "2026-09-01T00:00:00Z", project: "/p", passed: true },
    { ts: "2026-10-01T00:00:00Z", project: "/p", passed: false },
    { ts: "2026-10-01T00:00:00Z", project: "/other", passed: true },
  ];
  writeFileSync(join(home, "sessions.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await c.stats(env, { since: "2026-10-01", json: true });
  assert.deepEqual(JSON.parse(out.pop()!).sessions, { checked: 1, passed: 0, failed: 1 });
  await c.stats(env, { since: "2026-10-01", all: true, json: true });
  assert.deepEqual(JSON.parse(out.pop()!).sessions, { checked: 2, passed: 1, failed: 1 });
  appendFileSync(join(home, "sessions.jsonl"), "{torn");
  await assert.rejects(c.stats(env, { json: true }), /unreadable session record/);
  assert.equal(out.length, 0); // no plausible-looking partial report
});

test("unknown token usage never produces a measured token cost per result", () => {
  const summary = summarizeTasks([t({ tokens: 50_000, unknownUsageCalls: 1 })], "/p");
  assert.equal(summary.tokensPerVerified, null);
  assert.match(formatStats(summary), /budget-accounted tokens \(includes estimates\)/);
});
