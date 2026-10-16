import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bootId, identity, listeners, matches, members, signal, snapshot } from "./processes.mjs";
import { git, keyOf, LEASE_MS, load, touch, update } from "./state.mjs";
import { removeInspection } from "./git.mjs";

function selected(state, options) {
  const session = state.sessions[keyOf(options.session || "")];
  if (!session?.initialized || !session.active || session.needsBegin) throw new Error("begin-required: initialize this thread before launching resources");
  if (options.turn && options.turn !== session.turn) throw new Error("stale-turn");
  return session;
}

async function reuse(ctx, resource, options) {
  const key = keyOf(options.session);
  const turn = resource.leases[key].turn;
  const until = Date.now() + 15000;
  try {
    while (true) {
      const state = load(ctx);
      const current = state.resources[resource.id];
      if (!current || !["pending", "running"].includes(current.status)) throw new Error("shared-launch-failed");
      if (current.leases[key]?.turn !== turn) throw new Error(state.sessions[key]?.active && state.sessions[key].turn === turn ? "shared-launch-failed" : "shared-launch-cancelled");
      if (current.supervisor && !matches(current.supervisor)) throw new Error("shared-launch-failed: supervisor exited");
      if (current.status === "running") return { version: 1, code: "reused", resource: current.id, listeners: current.listeners };
      if (Date.now() >= until) throw new Error("shared-launch-timeout");
      await delay(50);
    }
  } catch (error) {
    await update(ctx, (state) => {
      const current = state.resources[resource.id];
      if (current?.leases[key]?.turn === turn) delete current.leases[key];
    });
    throw error;
  }
}

export async function run(ctx, options, argv, onOutput = () => {}) {
  if (!argv.length || !options.label || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.label)) throw new Error("run-requires-label-and-command");
  if (options.retain && !options.reason) throw new Error("retention-reason-required");
  bootId(); // Refuse unsupported process-control platforms before creating anything.
  const result = await update(ctx, (state) => {
    const session = selected(state, options);
    touch(state, session);
    const key = keyOf(session.id);
    const head = git(session.checkout, ["rev-parse", "HEAD"], 3000);
    const changes = git(session.checkout, ["diff", "HEAD", "--"], 3000);
    // Untracked source cannot be hashed safely without inspecting arbitrary local secrets.
    const untracked = git(session.checkout, ["ls-files", "--others", "--exclude-standard", "-z"], 3000);
    const reusableSource = [head, changes, untracked].every((result) => result.status === 0) && !untracked.stdout;
    const fingerprint = createHash("sha256").update(JSON.stringify([argv, session.checkout, head.stdout, changes.stdout, process.env])).digest("hex");
    const expires = Date.now() + (options.retain ? options.retain * 1000 : LEASE_MS);
    const lease = { turn: session.turn, expires, retained: Boolean(options.retain), reason: options.reason || "temporary" };
    const reusable = reusableSource && Object.values(state.resources).find((resource) => !options.foreground && !resource.foreground && resource.owned && resource.label === options.label && resource.fingerprint === fingerprint && (
      (resource.status === "running" && matches(resource.supervisor)) ||
      (resource.status === "pending" && Date.now() - resource.created < 15000 && (!resource.supervisor || matches(resource.supervisor)))
    ));
    if (reusable) { reusable.leases[key] = lease; return { reused: true, resource: reusable }; }
    const id = randomUUID();
    const resource = { id, label: options.label, owned: true, status: "pending", checkout: session.checkout, created: Date.now(), token: randomUUID(), supervisor: null, members: [], listeners: [], fingerprint, leases: { [key]: lease }, foreground: Boolean(options.foreground), foregroundOwner: options.foreground ? identity(process.pid) : null, owner: key };
    state.resources[id] = resource;
    return { reused: false, resource };
  });
  if (result.reused) return reuse(ctx, result.resource, options);
  const { resource } = result;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./supervisor.mjs", import.meta.url)), ctx.root, ctx.dir, resource.id], {
    cwd: resource.checkout, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error("launch-handshake-timeout")), 12000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.connected) child.disconnect();
      reject(error);
    };
    child.on("error", fail);
    child.on("exit", (code) => { if (!settled) fail(new Error(`supervisor-exited-before-completion: ${code}`)); });
    child.on("message", (message) => {
      if (message.type === "ready") child.send({ type: "launch", token: resource.token, argv, foreground: Boolean(options.foreground) });
      if (message.type === "output") onOutput(message.text);
      if (message.type === "error") fail(new Error(message.code));
      if (message.type === "started") {
        started = true;
        clearTimeout(timeout);
        if (!options.foreground) {
          settled = true;
          child.disconnect();
          child.unref();
          resolve({ version: 1, code: "started", resource: resource.id, supervisor: message.pid, checkout: resource.checkout, listeners: message.listeners });
        }
      }
      if (message.type === "done" && started && options.foreground) {
        settled = true;
        clearTimeout(timeout);
        if (child.connected) child.disconnect();
        child.unref();
        resolve({ version: 1, code: "completed", exitCode: message.exitCode, resource: resource.id });
      }
    });
  });
}

export async function borrow(ctx, options) {
  if (!options.pid || !options.label) throw new Error("borrow-requires-pid-and-label");
  const owner = identity(options.pid);
  if (!owner) throw new Error("borrowed-process-not-running");
  return update(ctx, (state) => {
    const session = selected(state, options);
    touch(state, session);
    const id = randomUUID();
    state.resources[id] = { id, label: options.label, owned: false, status: "running", checkout: session.checkout, created: Date.now(), supervisor: null, members: [owner], listeners: listeners([owner.pid]), leases: { [keyOf(session.id)]: { turn: session.turn, expires: session.expires, retained: false } } };
    return { version: 1, code: "borrowed", resource: id };
  });
}

// This runs outside the state lock; identities are checked afresh for every signal.
export async function terminate(resource) {
  let tracked = members(resource);
  const sentinel = resource.supervisor;
  const children = () => tracked.filter((item) => item.pid !== sentinel?.pid && matches(item));
  for (const item of children()) signal(item, "SIGTERM");
  const until = Date.now() + 5000;
  while (children().length && Date.now() < until) {
    await delay(100);
    tracked = members({ ...resource, members: tracked });
  }
  for (const item of children()) signal(item, "SIGKILL");
  await delay(80);
  tracked = members({ ...resource, members: tracked });
  if (children().length) return { ok: false, error: "owned-process-still-running", members: tracked };
  // Without a live sentinel or recorded member, an unknown surviving group is ambiguous.
  if (sentinel && !matches(sentinel) && snapshot().some((item) => !item.zombie && item.group === sentinel.pid)) return { ok: false, error: "unverified-descendants", members: tracked };
  return { ok: true, members: tracked };
}

export async function sweep(ctx, { wait = true } = {}) {
  const resources = await update(ctx, (state) => {
    const now = Date.now();
    for (const [key, session] of Object.entries(state.sessions)) {
      const busy = session.active && Object.values(state.resources).some((resource) => resource.foreground && resource.leases[key]?.turn === session.turn && matches(resource.foregroundOwner) && matches(resource.supervisor));
      if (session.owner && !matches(session.owner)) session.active = false;
      else if (busy) touch(state, session);
      else if (session.expires <= now) session.active = false;
    }
    for (const resource of Object.values(state.resources)) {
      for (const [key, lease] of Object.entries(resource.leases)) {
        if (lease.expires <= now || (!lease.retained && !state.sessions[key].active)) delete resource.leases[key];
      }
      if (!Object.keys(resource.leases).length && (resource.status !== "pending" || resource.supervisor || now - resource.created >= 15000)) resource.status = "stopping";
    }
    return Object.values(state.resources).map((resource) => structuredClone(resource));
  });
  for (const resource of resources) {
    const table = snapshot();
    if (!resource.owned) {
      if (!Object.keys(resource.leases).length || !resource.members.some((item) => matches(item, table))) await update(ctx, (state) => { delete state.resources[resource.id]; });
      continue;
    }
    if (resource.status === "pending" && !resource.supervisor && Date.now() - resource.created < 15000) continue;
    const managed = matches(resource.supervisor, table);
    if (managed && resource.supervisor.pid !== process.pid) continue; // Its live supervisor handles release.
    if (resource.status !== "stopping" && resource.status !== "failed" && managed) continue;
    if (!managed && !Object.keys(resource.leases).length && resource.status === "pending") resource.status = "stopping";
    if (!managed && resource.status !== "stopping" && resource.status !== "failed") {
      // A dead supervisor cannot renew its resources; recover its recorded children now.
      resource.status = "stopping";
    }
    if (resource.status !== "stopping" && resource.status !== "failed") continue;
    let done;
    try { done = await terminate(resource); }
    catch (error) { done = { ok: false, error: `termination-failed: ${error.code || "inspection-unavailable"}`, members: resource.members }; }
    await update(ctx, (state) => {
      const current = state.resources[resource.id];
      if (!current) return;
      if (done.ok) delete state.resources[resource.id];
      else { current.status = "failed"; current.error = done.error; current.members = done.members; }
    });
  }
  if (wait) {
    const until = Date.now() + 8000;
    while (Date.now() < until && Object.values(load(ctx).resources).some((resource) => resource.status === "stopping" && matches(resource.supervisor))) await delay(100);
  }
  // End callbacks return quickly. Supervisors retry here after resources drain; without a
  // supervisor, the next lifecycle entry retries. removeInspection rechecks under the Git lock.
  for (const session of Object.values(load(ctx).sessions)) if (!session.active && session.inspection) await removeInspection(ctx, session.id);
  const remaining = Object.values(load(ctx).resources);
  return { version: 1, code: remaining.some((item) => item.status === "failed" || item.status === "stopping") ? "cleanup-incomplete" : "reconciled", resources: remaining.length, failures: remaining.filter((item) => item.error).map((item) => ({ resource: item.id, error: item.error })) };
}

export async function finish(ctx, options, { wait = true, retained = true } = {}) {
  if (!options.session) throw new Error("session-id-required");
  const released = await update(ctx, (state) => {
    const key = keyOf(options.session);
    const session = state.sessions[key];
    if (!session || (options.turn && options.turn !== session.turn)) return false;
    session.active = false;
    session.updated = Date.now();
    for (const resource of Object.values(state.resources)) {
      const lease = resource.leases[key];
      if (lease && (!options.turn || lease.turn === options.turn) && (!retained || !lease.retained)) delete resource.leases[key];
    }
    return true;
  });
  if (!released) return { version: 1, code: "already-finished", resources: Object.keys(load(ctx).resources).length };
  if (!wait) {
    await update(ctx, (state) => {
      for (const resource of Object.values(state.resources)) if (!Object.keys(resource.leases).length) resource.status = "stopping";
    });
    return { version: 1, code: "cleanup-requested" };
  }
  const result = await sweep(ctx, { wait });
  return { ...result, code: result.code === "cleanup-incomplete" ? result.code : "finished" };
}
