import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const server = 'require("node:http").createServer((q,s)=>s.end("fixture")).listen(0,"127.0.0.1")';

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, { lean = false, codex = true, claude = true, defaultBranch = "main", inGit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-session-"));
  const answers = JSON.parse(readFileSync(join(root, "test/fixtures/answers.json"), "utf8"));
  answers.flags = { ...answers.flags, LEAN: lean, CODEX_HOOKS: codex, CLAUDE_CODE: claude };
  answers.vars.DEFAULT_BRANCH = defaultBranch;
  const input = join(dir, "answers.json");
  writeFileSync(input, JSON.stringify(answers));
  const render = spawnSync(process.execPath, [join(root, "project-setup/scripts/scaffold.mjs"), "--answers", input, "--target", dir], { encoding: "utf8" });
  assert.equal(render.status, 0, render.stderr);
  // Hook behavior tests isolate lifecycle from separate docs/fallow validation coverage.
  writeFileSync(join(dir, "scripts/checks/agent-stop.mjs"), 'import {readFileSync} from "node:fs";const p=JSON.parse(readFileSync(0,"utf8")||"{}");if(p.fixture_failure&&!p.stop_hook_active){console.error("fixture-check-failed");process.exit(2)}\n');
  if (inGit) { git(dir, "init", "-q", "-b", defaultBranch); git(dir, "add", "."); git(dir, "commit", "-qm", "fixture"); }
  const state = await import(pathToFileURL(join(dir, "scripts/session/state.mjs")));
  const runtime = await import(pathToFileURL(join(dir, "scripts/session/runtime.mjs")));
  const processes = await import(pathToFileURL(join(dir, "scripts/session/processes.mjs")));
  const ctx = state.context(dir);
  t.after(async () => {
    try {
      for (const item of Object.values(state.load(ctx).sessions)) await runtime.finish(ctx, { session: item.id }, { retained: false });
      await runtime.sweep(ctx);
      assert.equal(Object.keys(state.load(ctx).resources).length, 0, "fixture must not leak managed processes");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const cli = async (...args) => {
    const { stdout } = await execute(process.execPath, [join(dir, "scripts/session/cli.mjs"), args[0], "--json", ...args.slice(1)], { cwd: dir, timeout: 25000 });
    return JSON.parse(stdout);
  };
  const hook = async (event, session, extra = {}) => {
    const child = spawn(process.execPath, [join(dir, "scripts/session/hooks.mjs"), "codex"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const ended = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: session, cwd: dir, ...extra }));
    assert.equal(await ended, 0, stderr);
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  return { dir, cli, hook, state, runtime, processes, ctx };
}

async function waitFor(task, timeout = 6000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await task(); if (result) return result; await delay(100); }
  assert.fail("condition did not become true before timeout");
}

async function isolatedFixture(t) {
  const f = await fixture(t);
  const remote = join(f.dir, "..", `${f.dir.split("/").at(-1)}.git`);
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git(f.dir, "init", "--bare", remote);
  git(f.dir, "remote", "add", "origin", remote);
  git(f.dir, "push", "-u", "origin", "main");
  const isolated = await f.cli("begin", "--session", "inspection", "--isolate");
  assert.equal(isolated.code, "isolated");
  return { ...f, isolated };
}

function gateLaunch(f) {
  const gate = join(f.ctx.dir, "fixture-launch-ready");
  const script = join(f.dir, "scripts/session/supervisor.mjs");
  writeFileSync(script, `import { existsSync as fixtureReady } from "node:fs";\nwhile (!fixtureReady(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 20));\n${readFileSync(script, "utf8")}`);
  return () => writeFileSync(gate, "ready");
}

test("managed launch records actual listeners and finish releases child listeners and empties the document", async (t) => {
  const f = await fixture(t);
  await f.cli("begin", "--session", "one", "--intent", "continue", "--reason", "fixture");
  const code = `const {spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(server)}],{stdio:"ignore"});setInterval(()=>{},1000)`;
  const started = await f.cli("run", "--session", "one", "--label", "web", "--", process.execPath, "-e", code);
  assert.equal(started.code, "started");
  const resource = await waitFor(() => Object.values(f.state.load(f.ctx).resources).find((item) => item.listeners?.length));
  const actual = resource.listeners.find((item) => item.startsWith("127.0.0.1:"));
  assert.equal(await (await fetch(`http://${actual}`)).text(), "fixture");
  assert.match(readFileSync(join(f.dir, ".agents/sessions.md"), "utf8"), /web/);
  const owned = resource.members;
  assert.equal((await f.cli("finish", "--session", "one")).code, "finished");
  assert.equal(readFileSync(join(f.dir, ".agents/sessions.md"), "utf8"), "");
  await waitFor(() => owned.every((item) => !f.processes.matches(item)));
});

test("shared managed service survives until last lease; borrowed service is never stopped", async (t) => {
  const f = await fixture(t);
  for (const session of ["one", "two"]) await f.cli("begin", "--session", session, "--intent", "continue", "--reason", "shared fixture");
  const one = await f.cli("run", "--session", "one", "--label", "shared", "--", process.execPath, "-e", server);
  const two = await f.cli("run", "--session", "two", "--label", "shared", "--", process.execPath, "-e", server);
  assert.equal(two.code, "reused");
  assert.equal(two.resource, one.resource);
  await f.cli("finish", "--session", "one");
  assert.ok(f.state.load(f.ctx).resources[one.resource]);
  const user = spawn(process.execPath, ["-e", server], { stdio: "ignore" });
  t.after(() => { user.kill(); });
  await f.cli("borrow", "--session", "two", "--pid", String(user.pid), "--label", "user");
  await f.cli("finish", "--session", "two");
  assert.ok(f.processes.identity(user.pid));
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 0);
});

for (const outcome of ["success", "failure", "cancelled"]) test(`concurrent compatible pending launches share one service (${outcome})`, async (t) => {
  const f = await fixture(t);
  for (const session of ["one", "two"]) await f.cli("begin", "--session", session, "--intent", "continue", "--reason", "shared fixture");
  const release = gateLaunch(f);
  const argv = outcome === "failure" ? [join(f.dir, "missing-executable")] : [process.execPath, "-e", server];
  const launches = [];
  try {
    launches.push(f.runtime.run(f.ctx, { session: "one", label: "shared" }, argv));
    launches[0].catch(() => {});
    await waitFor(() => Object.values(f.state.load(f.ctx).resources).some((item) => item.status === "pending"));
    launches.push(f.runtime.run(f.ctx, { session: "two", label: "shared" }, argv));
    launches[1].catch(() => {});
    await waitFor(() => Object.values(f.state.load(f.ctx).resources).some((item) => item.status === "pending" && Object.keys(item.leases).length === 2));
    assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 1);
    if (outcome === "cancelled") await f.cli("finish", "--session", "two");
    release();
    const results = await Promise.allSettled(launches);
    if (outcome === "failure") {
      assert.ok(results.every((result) => result.status === "rejected"));
      assert.match(results[0].reason.message, /command-launch-failed/);
      assert.match(results[1].reason.message, /shared-launch-failed/);
      await waitFor(() => Object.keys(f.state.load(f.ctx).resources).length === 0);
    } else {
      assert.equal(results[0].status, "fulfilled");
      assert.equal(results[0].value.code, "started");
      if (outcome === "cancelled") {
        assert.equal(results[1].status, "rejected");
        assert.match(results[1].reason.message, /shared-launch-cancelled/);
      } else {
        assert.equal(results[1].status, "fulfilled");
        assert.equal(results[1].value.code, "reused");
        assert.equal(results[0].value.resource, results[1].value.resource);
      }
      const resource = await waitFor(() => Object.values(f.state.load(f.ctx).resources).find((item) => item.listeners?.length));
      assert.equal(await (await fetch(`http://${resource.listeners[0]}`)).text(), "fixture");
      await f.cli("finish", "--session", "one");
      assert.equal(Boolean(f.state.load(f.ctx).resources[resource.id]), outcome !== "cancelled");
      await f.cli("finish", "--session", "two");
      assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 0);
    }
  } finally { release(); await Promise.allSettled(launches); }
});

test("Stop checks block a handoff, but unchanged and recursion-guard handoffs still clean resources", async (t) => {
  const f = await fixture(t);
  await f.hook("SessionStart", "hook", { source: "startup" });
  const denied = await f.hook("PreToolUse", "hook", { tool_name: "Bash", tool_input: { command: "npm run dev" } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  await f.cli("begin", "--session", "hook", "--turn", "turn-1", "--intent", "continue", "--reason", "fixture");
  await f.cli("run", "--session", "hook", "--label", "web", "--", process.execPath, "-e", server);
  const blocked = await f.hook("Stop", "hook", { turn_id: "turn-1", fixture_failure: true });
  assert.equal(blocked.decision, "block");
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 1);
  await f.hook("Stop", "hook", { turn_id: "turn-1", fixture_failure: true, stop_hook_active: true });
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 0);
  await f.hook("UserPromptSubmit", "hook", { turn_id: "turn-2" });
  await f.cli("begin", "--session", "hook", "--turn", "turn-2", "--intent", "continue", "--reason", "fixture");
  await f.cli("run", "--session", "hook", "--label", "web", "--", process.execPath, "-e", server);
  await f.hook("PostToolUse", "hook", { turn_id: "turn-1", tool_name: "Bash" });
  assert.equal(f.state.load(f.ctx).sessions[f.state.keyOf("hook")].turn, "turn-2");
  await f.hook("Stop", "hook", { turn_id: "turn-1" });
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 1, "late Stop cannot release the next turn");
  await f.hook("Stop", "hook", { turn_id: "turn-2" });
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 0);
});

test("short end callback persists release and supervisor finishes it without another prompt", async (t) => {
  const f = await fixture(t);
  await f.cli("begin", "--session", "end", "--intent", "continue", "--reason", "fixture");
  await f.cli("run", "--session", "end", "--label", "web", "--", process.execPath, "-e", server);
  const start = Date.now();
  await f.hook("SessionEnd", "end");
  assert.ok(Date.now() - start < 2900);
  await waitFor(() => Object.keys(f.state.load(f.ctx).resources).length === 0);
});

for (const event of ["SessionEnd", "Interrupt", "StopFailure"]) test(`sweep reaps a clean inspection checkout after ${event} without a managed service`, async (t) => {
  const f = await isolatedFixture(t);
  await f.hook(event, "inspection");
  await f.cli("sweep");
  assert.equal(existsSync(f.isolated.checkout), false);
  assert.ok(existsSync(f.dir));
  const session = f.state.load(f.ctx).sessions[f.state.keyOf("inspection")];
  assert.equal(session.inspection, undefined);
  assert.equal(session.checkout, f.ctx.root);
});

test("supervisor reaps an inspection checkout after its service drains following interruption", async (t) => {
  const f = await isolatedFixture(t);
  await f.cli("run", "--session", "inspection", "--label", "web", "--", process.execPath, "-e", server);
  await f.hook("Interrupt", "inspection");
  await waitFor(() => !existsSync(f.isolated.checkout) && !f.state.load(f.ctx).sessions[f.state.keyOf("inspection")].inspection);
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 0);
  assert.equal(f.state.load(f.ctx).sessions[f.state.keyOf("inspection")].inspection, undefined);
});

test("retained services keep their inspection checkout until the final lease expires", async (t) => {
  const f = await isolatedFixture(t);
  await f.cli("run", "--session", "inspection", "--label", "web", "--retain", "120", "--reason", "requested preview", "--", process.execPath, "-e", server);
  await f.hook("SessionEnd", "inspection");
  await f.cli("sweep");
  assert.ok(existsSync(f.isolated.checkout));
  await f.state.update(f.ctx, (state) => {
    for (const resource of Object.values(state.resources)) for (const lease of Object.values(resource.leases)) lease.expires = 0;
  });
  await f.cli("sweep");
  assert.equal(existsSync(f.isolated.checkout), false);
});

test("sweep preserves changed inspection checkouts and their recovery records", async (t) => {
  const f = await isolatedFixture(t);
  const output = join(f.isolated.checkout, "unfinished.txt");
  writeFileSync(output, "preserve");
  await f.hook("SessionEnd", "inspection");
  await f.state.update(f.ctx, (state) => { state.sessions[f.state.keyOf("inspection")].updated = 0; });
  await f.cli("sweep");
  assert.equal(readFileSync(output, "utf8"), "preserve");
  assert.equal(f.state.load(f.ctx).sessions[f.state.keyOf("inspection")].inspection.path, f.isolated.checkout);
});

test("retained leases survive finish, then expiry sweeps them", async (t) => {
  const f = await fixture(t);
  await f.cli("begin", "--session", "preview", "--intent", "continue", "--reason", "fixture");
  await f.cli("run", "--session", "preview", "--label", "web", "--retain", "120", "--reason", "requested preview", "--", process.execPath, "-e", server);
  await f.cli("finish", "--session", "preview");
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 1);
  await f.state.update(f.ctx, (state) => { for (const resource of Object.values(state.resources)) for (const lease of Object.values(resource.leases)) lease.expires = 0; });
  await f.cli("sweep");
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 0);
});

test("dead supervisor is recovered from durable member identities; PID replacement is preserved", async (t) => {
  const f = await fixture(t);
  await f.cli("begin", "--session", "crash", "--intent", "continue", "--reason", "fixture");
  const started = await f.cli("run", "--session", "crash", "--label", "web", "--", process.execPath, "-e", server);
  await waitFor(() => f.state.load(f.ctx).resources[started.resource]?.members.length > 1);
  process.kill(started.supervisor, "SIGKILL");
  await f.cli("sweep");
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 0);
  const user = spawn(process.execPath, ["-e", server], { stdio: "ignore" });
  t.after(() => user.kill());
  await f.state.update(f.ctx, (state) => {
    const id = "00000000-0000-0000-0000-000000000000";
    const actual = f.processes.identity(user.pid);
    state.resources[id] = { id, label: "old-pid", owned: true, status: "stopping", checkout: f.ctx.root, created: 0, supervisor: null, members: [{ ...actual, start: "different-start" }], leases: {} };
  });
  await f.cli("sweep");
  assert.ok(f.processes.identity(user.pid));
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 0);
});

test("registry path escapes and corrupt schemas fail without clearing state", async (t) => {
  const f = await fixture(t);
  const outside = join(f.dir, "user.md");
  writeFileSync(outside, "preserve");
  symlinkSync(outside, join(f.dir, ".agents/sessions.md"));
  await assert.rejects(f.cli("begin", "--session", "unsafe"), /unsafe-runtime-path/);
  assert.equal(readFileSync(outside, "utf8"), "preserve");
  rmSync(join(f.dir, ".agents/sessions.md"));
  writeFileSync(join(f.ctx.dir, "state.json"), '{"version":100,"sessions":{},"resources":{}}');
  await assert.rejects(f.cli("sweep"), /invalid-runtime-schema/);
  assert.equal(JSON.parse(readFileSync(join(f.ctx.dir, "state.json"))).version, 100);
  writeFileSync(join(f.ctx.dir, "state.json"), '{"version":1,"sessions":{},"resources":{}}');
});

test("fresh thread fast-forwards configured default exactly once, preserves dirty/feature/ahead work", async (t) => {
  const f = await fixture(t, { defaultBranch: "trunk" });
  const remote = join(f.dir, "..", `${f.dir.split("/").at(-1)}.git`);
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git(f.dir, "init", "--bare", remote);
  git(f.dir, "remote", "add", "origin", remote);
  git(f.dir, "push", "-u", "origin", "trunk");
  const old = git(f.dir, "rev-parse", "HEAD");
  writeFileSync(join(f.dir, "upstream.txt"), "new upstream");
  git(f.dir, "add", "."); git(f.dir, "commit", "-qm", "remote update"); git(f.dir, "push");
  const latest = git(f.dir, "rev-parse", "HEAD");
  git(f.dir, "reset", "--hard", old);
  git(f.dir, "switch", "-c", "chore/stale");
  const synced = await f.cli("begin", "--session", "fresh");
  assert.equal(synced.git.code, "synced");
  assert.equal(git(f.dir, "branch", "--show-current"), "trunk");
  assert.equal(git(f.dir, "rev-parse", "HEAD"), latest);
  await f.cli("finish", "--session", "fresh");
  git(f.dir, "switch", "-c", "feat/work");
  writeFileSync(join(f.dir, "local.txt"), "unfinished");
  assert.equal((await f.cli("begin", "--session", "fresh")).git.code, "preserved-checkout-moved");
  await f.cli("finish", "--session", "fresh");
  assert.equal((await f.cli("begin", "--session", "dirty")).git.code, "preserved-dirty");
  await f.cli("finish", "--session", "dirty");
  git(f.dir, "add", "."); git(f.dir, "commit", "-qm", "local work");
  assert.equal((await f.cli("begin", "--session", "feature")).git.code, "preserved-branch");
  await f.cli("finish", "--session", "feature");
  git(f.dir, "switch", "trunk");
  git(f.dir, "commit", "--allow-empty", "-m", "local main work");
  assert.equal((await f.cli("begin", "--session", "ahead")).git.code, "preserved-main-ahead");
  await f.cli("finish", "--session", "ahead");
  git(f.dir, "branch", "-m", "trunk", "feat/saved-trunk");
  git(f.dir, "switch", "--detach", "origin/trunk");
  git(f.dir, "switch", "-c", "chore/bootstrap");
  assert.equal((await f.cli("begin", "--session", "missing-local-default")).git.code, "synced");
  assert.equal(git(f.dir, "branch", "--show-current"), "trunk");
  assert.ok(git(f.dir, "rev-parse", "feat/saved-trunk"), "unpushed work remains on its saved branch");
});

test("concurrent checkout users get isolated worktrees and preserve changed inspection work", async (t) => {
  const f = await fixture(t);
  const remote = join(f.dir, "..", `${f.dir.split("/").at(-1)}.git`);
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git(f.dir, "init", "--bare", remote); git(f.dir, "remote", "add", "origin", remote); git(f.dir, "push", "-u", "origin", "main");
  const [one, two] = await Promise.all([f.cli("begin", "--session", "one"), f.cli("begin", "--session", "two")]);
  assert.deepEqual([one.git.code, two.git.code].sort(), ["isolated", "synced"]);
  const isolated = one.git.code === "isolated" ? one : two;
  assert.ok(existsSync(isolated.checkout));
  writeFileSync(join(isolated.checkout, "unfinished.txt"), "keep");
  await f.cli("finish", "--session", isolated.session);
  assert.ok(existsSync(join(isolated.checkout, "unfinished.txt")));
});

test("all presets include lifecycle; native hook outputs are gated and parseable", async (t) => {
  for (const lean of [false, true]) for (const codex of [false, true]) {
    const f = await fixture(t, { lean, codex, claude: false });
    assert.ok(existsSync(join(f.dir, ".agents/skills/sweep/SKILL.md")));
    assert.ok(existsSync(join(f.dir, "docs/session-lifecycle.md")));
    assert.equal(existsSync(join(f.dir, ".codex/hooks.json")), codex);
    if (codex) assert.ok(JSON.parse(readFileSync(join(f.dir, ".codex/hooks.json"))).hooks.SessionEnd);
    for (const file of ["cli.mjs", "hooks.mjs", "supervisor.mjs", "git.mjs", "state.mjs", "processes.mjs", "runtime.mjs"]) {
      const check = spawnSync("node", ["--check", join(f.dir, "scripts/session", file)], { encoding: "utf8" });
      assert.equal(check.status, 0, check.stderr);
    }
  }
});

test("foreground work returns its exit status, renews busy leases, and failed launches leave no listener", async (t) => {
  const f = await fixture(t);
  await f.cli("begin", "--session", "foreground", "--intent", "continue", "--reason", "fixture");
  let output = "";
  const running = f.runtime.run(f.ctx, { session: "foreground", label: "long-test", foreground: true }, [process.execPath, "-e", 'console.log("busy-fixture");setTimeout(()=>process.exit(7),1800)'], (text) => { output += text; });
  await waitFor(() => Object.values(f.state.load(f.ctx).resources).some((resource) => resource.status === "running"));
  await f.state.update(f.ctx, (state) => {
    state.sessions[f.state.keyOf("foreground")].expires = 0;
    for (const resource of Object.values(state.resources)) for (const lease of Object.values(resource.leases)) lease.expires = 0;
  });
  await f.cli("sweep");
  await delay(800);
  assert.ok(f.state.load(f.ctx).sessions[f.state.keyOf("foreground")].active);
  const completed = await running;
  assert.equal(completed.exitCode, 7);
  assert.match(output, /busy-fixture/);
  assert.equal(Object.keys(f.state.load(f.ctx).resources).length, 0);
  await assert.rejects(f.cli("run", "--session", "foreground", "--label", "broken", "--", join(f.dir, "missing-executable")), /command-launch-failed/);
  await waitFor(() => Object.keys(f.state.load(f.ctx).resources).length === 0);
});

test("pre-Git resources and thread identity survive git init", async (t) => {
  const f = await fixture(t, { inGit: false });
  const first = await f.cli("begin", "--session", "pre-git");
  assert.equal(first.git.code, "not-applicable");
  await f.cli("run", "--session", "pre-git", "--label", "web", "--", process.execPath, "-e", server);
  git(f.dir, "init", "-q", "-b", "main"); git(f.dir, "add", "."); git(f.dir, "commit", "-qm", "fixture");
  await f.cli("finish", "--session", "pre-git");
  assert.equal(readFileSync(join(f.dir, ".agents/sessions.md"), "utf8"), "");
  assert.equal((await f.cli("begin", "--session", "pre-git")).git.code, "preserved-checkout-moved");
  assert.equal(f.state.context(f.dir).dir, f.ctx.dir);
});

test("verified owner death triggers cleanup without another lifecycle command", async (t) => {
  const f = await fixture(t);
  const owner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => owner.kill());
  await f.cli("begin", "--session", "owner", "--intent", "continue", "--reason", "fixture", "--owner-pid", String(owner.pid));
  await f.cli("run", "--session", "owner", "--label", "web", "--", process.execPath, "-e", server);
  owner.kill();
  await waitFor(() => Object.keys(f.state.load(f.ctx).resources).length === 0);
});

test("missing/offline upstream and ongoing Git operations preserve state; explicit local refs work offline", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.cli("begin", "--session", "missing")).git.code, "missing-remote");
  await f.cli("finish", "--session", "missing");
  git(f.dir, "remote", "add", "origin", join(f.dir, "does-not-exist.git"));
  assert.equal((await f.cli("begin", "--session", "offline")).git.code, "unverified-offline");
  await f.cli("finish", "--session", "offline");
  writeFileSync(join(f.dir, ".git/MERGE_HEAD"), `${git(f.dir, "rev-parse", "HEAD")}\n`);
  assert.equal((await f.cli("begin", "--session", "operation")).git.code, "preserved-operation");
  await f.cli("finish", "--session", "operation");
  rmSync(join(f.dir, ".git/MERGE_HEAD"));
  const target = await f.cli("begin", "--session", "target", "--intent", "target", "--ref", "HEAD", "--reason", "inspect requested local commit");
  assert.equal(target.git.code, "target-selected");
  assert.equal(git(f.dir, "branch", "--show-current"), "");
});

test("stale lock recovery is serialized across concurrent status requests", async (t) => {
  const f = await fixture(t);
  const fake = { token: "abandoned", owner: { ...f.processes.identity(process.pid), start: "old-start" } };
  writeFileSync(join(f.ctx.dir, "state.lock"), JSON.stringify(fake));
  const results = await Promise.all([f.cli("status"), f.cli("status"), f.cli("status")]);
  assert.ok(results.every((result) => result.code === "reconciled"));
  assert.equal(existsSync(join(f.ctx.dir, "state.lock")), false);
});

test("main checked out elsewhere uses a disposable inspection worktree and removes only that worktree", async (t) => {
  const f = await fixture(t);
  const remote = join(f.dir, "..", `${f.dir.split("/").at(-1)}.git`);
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git(f.dir, "init", "--bare", remote); git(f.dir, "remote", "add", "origin", remote); git(f.dir, "push", "-u", "origin", "main");
  git(f.dir, "switch", "-c", "feat/selected");
  const existing = join(f.dir, ".worktrees/user-main");
  git(f.dir, "worktree", "add", existing, "main");
  const begun = await f.cli("begin", "--session", "inspection");
  assert.equal(begun.git.code, "isolated");
  await f.cli("finish", "--root", begun.checkout, "--session", "inspection");
  assert.equal(existsSync(begun.checkout), false);
  assert.ok(existsSync(existing));
  assert.equal(git(f.dir, "branch", "--show-current"), "feat/selected");
});
