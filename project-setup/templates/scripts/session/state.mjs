import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, linkSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { identity, matches } from "./processes.mjs";

export const VERSION = 1;
export const LEASE_MS = 30 * 60 * 1000;
export const keyOf = (id) => createHash("sha256").update(id).digest("hex").slice(0, 32);

export function git(cwd, args, timeout = 30000) {
  return spawnSync("git", args, {
    cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "/usr/bin/false", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes" },
  });
}

// Reject symlinks and multiply linked files below a canonical root before reads or writes.
export function safePath(root, file) {
  const target = resolve(file);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("unsafe-runtime-path");
  let current = root;
  for (const part of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink > 1)) throw new Error(`unsafe-runtime-path: ${current}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return target;
}

export function atomic(root, file, content) {
  safePath(root, file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { safePath(root, file); renameSync(temp, file); }
  finally { try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}

export function context(cwd = process.cwd()) {
  const selected = realpathSync(cwd);
  const top = git(selected, ["rev-parse", "--show-toplevel"], 3000);
  const root = top.status === 0 ? realpathSync(top.stdout.trim()) : selected;
  const common = top.status === 0 ? git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 3000) : null;
  if (common && common.status !== 0) throw new Error("git-common-dir-unavailable");
  const anchor = common ? realpathSync(common.stdout.trim()) : root;
  const dir = common ? join(anchor, "agent-runtime", "v1") : join(root, ".agents", ".runtime");
  safePath(anchor, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const result = { root, dir, anchor, inGit: Boolean(common) };
  // Migrate pre-Git state without destroying it or changing running supervisor paths.
  const primary = common ? git(root, ["worktree", "list", "--porcelain"], 3000).stdout?.split("\n").find((line) => line.startsWith("worktree "))?.slice(9) : root;
  const legacyRoot = primary ? realpathSync(primary) : root;
  const fallback = join(legacyRoot, ".agents", ".runtime");
  if (common) {
    safePath(legacyRoot, join(fallback, "state.json"));
    try {
      const old = JSON.parse(readFileSync(join(fallback, "state.json"), "utf8"));
      validate(old);
      if (Object.keys(old.resources).length || Object.keys(old.sessions).length) {
        result.dir = fallback;
        result.anchor = legacyRoot;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return result;
}

function validateIdentity(item) {
  return item === null || (item && Number.isSafeInteger(item.pid) && item.pid > 1 && typeof item.start === "string" && typeof item.boot === "string");
}

export function validate(state) {
  if (!state || state.version !== VERSION || !state.sessions || !state.resources || Array.isArray(state.sessions) || Array.isArray(state.resources)) throw new Error("invalid-runtime-schema");
  for (const [key, session] of Object.entries(state.sessions)) {
    if (key !== keyOf(session.id ?? "") || typeof session.id !== "string" || !session.id || typeof session.checkout !== "string" || !isAbsolute(session.checkout) || typeof session.turn !== "string" || typeof session.active !== "boolean" || typeof session.initialized !== "boolean" || !Number.isFinite(session.expires) || !validateIdentity(session.owner)) throw new Error("invalid-session-record");
  }
  for (const [key, resource] of Object.entries(state.resources)) {
    if (!/^[a-f0-9-]{36}$/.test(key) || resource.id !== key || !Array.isArray(resource.members) || !resource.members.every(validateIdentity) || resource.members.some((item) => item === null) || !validateIdentity(resource.supervisor) || !resource.leases || !["pending", "running", "stopping", "failed"].includes(resource.status) || typeof resource.owned !== "boolean" || typeof resource.label !== "string" || !Number.isFinite(resource.created) || typeof resource.checkout !== "string" || !isAbsolute(resource.checkout)) throw new Error("invalid-resource-record");
    for (const [session, lease] of Object.entries(resource.leases)) {
      if (!state.sessions[session] || typeof lease.turn !== "string" || !Number.isFinite(lease.expires) || typeof lease.retained !== "boolean") throw new Error("invalid-resource-lease");
    }
  }
  return state;
}

export async function lock(ctx, name, task, timeout = 8000) {
  const file = join(ctx.dir, `${name}.lock`);
  safePath(ctx.anchor, file);
  const candidate = join(ctx.dir, `${name}.${randomUUID()}.candidate`);
  const token = randomUUID();
  atomic(ctx.anchor, candidate, JSON.stringify({ token, owner: identity(process.pid) }));
  const until = Date.now() + timeout;
  let acquired = false;
  try {
    while (!acquired) {
      try { linkSync(candidate, file); acquired = true; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        // The hard link exposes a complete owner record, never an empty lockfile.
        let stat;
        try { stat = lstatSync(file); }
        catch (gone) { if (gone.code === "ENOENT") continue; throw gone; }
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe-runtime-lock");
        let current;
        try { current = JSON.parse(readFileSync(file, "utf8")); }
        catch (gone) { if (gone.code === "ENOENT") continue; throw gone; }
        if (!validateIdentity(current.owner) || !current.owner || typeof current.token !== "string") throw new Error("invalid-runtime-lock");
        if (!matches(current.owner)) {
          // Serialize stale-owner removal so a second recoverer cannot unlink a new live lock.
          const reaper = `${file}.reaper`;
          const reaperStat = (() => { try { return lstatSync(reaper); } catch (gone) { if (gone.code === "ENOENT") return null; throw gone; } })();
          if (reaperStat && !reaperStat.isFile()) throw new Error("unsafe-runtime-lock");
          try { linkSync(candidate, reaper); }
          catch (held) {
            if (held.code !== "EEXIST") throw held;
            let recovery;
            try { recovery = JSON.parse(readFileSync(reaper, "utf8")); }
            catch (gone) { if (gone.code === "ENOENT") continue; throw gone; }
            if (!validateIdentity(recovery.owner) || !recovery.owner || !matches(recovery.owner)) throw new Error(`abandoned-lock-recovery: ${name}`);
            if (Date.now() >= until) throw new Error(`runtime-lock-recovery-busy: ${name}`);
            await delay(40);
            continue;
          }
          try {
            let again;
            try { again = JSON.parse(readFileSync(file, "utf8")); }
            catch (gone) { if (gone.code !== "ENOENT") throw gone; }
            if (again && again.token === current.token && !matches(again.owner)) unlinkSync(file);
          } finally { unlinkSync(reaper); }
        } else if (Date.now() >= until) throw new Error(`runtime-lock-busy: ${name}`);
        else await delay(40);
      }
    }
    unlinkSync(candidate);
    return await task();
  } finally {
    if (acquired) {
      const current = JSON.parse(readFileSync(file, "utf8"));
      if (current.token !== token) throw new Error("runtime-lock-owner-changed");
      unlinkSync(file);
    }
    try { unlinkSync(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function load(ctx) {
  const file = safePath(ctx.anchor, join(ctx.dir, "state.json"));
  try {
    const state = validate(JSON.parse(readFileSync(file, "utf8")));
    let listing = git(ctx.root, ["worktree", "list", "--porcelain"], 3000);
    if (ctx.inGit && listing.status !== 0) listing = git(ctx.anchor, ["worktree", "list", "--porcelain"], 3000);
    if (ctx.inGit && listing.status !== 0) throw new Error("checkout-inventory-unavailable");
    const allowed = new Set(listing.status === 0 ? listing.stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)) : [ctx.root]);
    for (const [key, session] of Object.entries(state.sessions)) {
      const item = session.inspection;
      if (item && typeof item.parent === "string" && allowed.has(item.parent) && item.path === join(item.parent, ".worktrees", `session-${key.slice(0, 12)}`)) allowed.add(item.path);
    }
    for (const item of [...Object.values(state.sessions), ...Object.values(state.resources)]) if (!allowed.has(item.checkout)) throw new Error("unregistered-checkout-in-runtime");
    return state;
  }
  catch (error) { if (error.code !== "ENOENT") throw error; return { version: VERSION, sessions: {}, resources: {} }; }
}

function projection(ctx, state) {
  const rows = Object.values(state.resources).map((resource) => {
    const clean = (text) => String(text).replace(/[|\n\r]/g, " ");
    const expiry = Object.values(resource.leases).map((lease) => `${lease.retained ? "retained" : "temporary"} until ${new Date(lease.expires).toISOString()}`).join(", ");
    return `| ${clean(resource.label)} | ${resource.owned ? "managed" : "borrowed"} | ${clean(resource.status)} | ${Object.keys(resource.leases).map((key) => clean(state.sessions[key].id)).join(", ")} | ${clean(resource.checkout)} | ${clean((resource.listeners ?? []).join(", ") || "not observed")} | ${clean(expiry)} | ${clean(resource.error ?? "")} |`;
  });
  const content = rows.length ? `# Active session resources\n\nGenerated; inspect with the session CLI. Unresolved failures remain visible.\n\n| Resource | Ownership | State | Threads | Checkout | Listeners | Lease expiry | Failure |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n` : "";
  const roots = new Set([ctx.root, ...Object.values(state.sessions).map((session) => session.checkout)]);
  for (const root of roots) {
    // A removed checkout needs no projection; never recreate it merely for a status update.
    try { if (realpathSync(root) !== root) throw new Error("unsafe-checkout-path"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    atomic(root, join(root, ".agents", "sessions.md"), content);
  }
}

export async function update(ctx, task) {
  return lock(ctx, "state", async () => {
    const state = load(ctx);
    const result = await task(state);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [key, session] of Object.entries(state.sessions)) {
      if (!session.active && !session.inspection && session.updated < cutoff && !Object.values(state.resources).some((item) => item.leases[key])) delete state.sessions[key];
    }
    validate(state);
    atomic(ctx.anchor, join(ctx.dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    projection(ctx, state);
    return result;
  });
}

export function sessionFor(state, id, checkout, turn, source = "startup") {
  if (typeof id !== "string" || !id || id.length > 512) throw new Error("invalid-session-id");
  const key = keyOf(id);
  let session = state.sessions[key];
  if (!session) session = state.sessions[key] = { id, checkout, turn: turn || randomUUID(), source, active: false, initialized: false, owner: null, expires: 0, updated: Date.now() };
  return session;
}

export function touch(state, session, turn) {
  if (turn && turn !== session.turn) session.turn = turn;
  session.active = true;
  session.updated = Date.now();
  session.expires = Date.now() + LEASE_MS;
  for (const resource of Object.values(state.resources)) {
    const lease = resource.leases[keyOf(session.id)];
    if (lease && lease.turn === session.turn && !lease.retained) lease.expires = session.expires;
  }
}
