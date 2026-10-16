// One ephemeral process-group sentinel per managed service. No TCP control server or log files.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { context, LEASE_MS, load, update } from "./state.mjs";
import { identity, listeners, members } from "./processes.mjs";
import { sweep } from "./runtime.mjs";

const [root, storage, id] = process.argv.slice(2);
const ctx = context(root);
// A pre-Git supervisor keeps its original registry across subsequent git init.
if (realpathSync(storage) !== ctx.dir) throw new Error("supervisor-registry-moved");
let launched = false;
let exited = false;
let exitCode = 1;
let stopping = false;
let busy = false;
let starting = false;
const send = (message) => new Promise((resolve) => { if (process.connected) process.send(message, resolve); else resolve(); });

async function inspect() {
  if (busy || starting) return;
  busy = true;
  try {
    await update(ctx, (state) => {
      const resource = state.resources[id];
      if (!resource) return;
      resource.members = members(resource);
      resource.listeners = listeners(resource.members.map((item) => item.pid));
      if (resource.foreground && process.connected && !exited) {
        const owner = state.sessions[resource.owner];
        if (owner?.active) {
          owner.expires = Date.now() + LEASE_MS;
          const lease = resource.leases[resource.owner];
          if (lease && lease.turn === owner.turn) lease.expires = owner.expires;
        }
      }
      if (stopping || exited) resource.leases = {};
    });
    await sweep(ctx, { wait: false });
    if (!load(ctx).resources[id]) {
      await send({ type: "done", exitCode });
      process.exit(0);
    }
  } finally { busy = false; }
}

process.on("disconnect", () => { if (!launched || load(ctx).resources[id]?.foreground) stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
process.on("message", async (message) => {
  if (launched || message.type !== "launch") return;
  try {
    const resource = load(ctx).resources[id];
    if (!resource || message.token !== resource.token || !Array.isArray(message.argv) || !message.argv.length || !message.argv.every((part) => typeof part === "string" && !part.includes("\0"))) throw new Error("invalid-launch-handshake");
    launched = true;
    starting = true;
    let launchError = false;
    const child = spawn(message.argv[0], message.argv.slice(1), { cwd: resource.checkout, stdio: resource.foreground ? ["ignore", "pipe", "pipe"] : "ignore" });
    child.on("error", () => { exited = true; exitCode = 127; launchError = true; });
    child.on("exit", (code) => { exited = true; exitCode = code ?? 1; });
    if (resource.foreground) for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => send({ type: "output", text: chunk.toString() }));
    await update(ctx, (state) => {
      const current = state.resources[id];
      current.status = "running";
      current.members = members(current);
    });
    await delay(200);
    if (launchError) throw new Error("command-launch-failed");
    send({ type: "started", pid: process.pid, listeners: listeners(members(load(ctx).resources[id]).map((item) => item.pid)) });
  } catch (error) { stopping = true; send({ type: "error", code: error.message }); }
  finally { starting = false; }
});

try {
  await update(ctx, (state) => {
    const resource = state.resources[id];
    if (!resource || resource.status !== "pending") throw new Error("pending-resource-missing");
    resource.supervisor = identity(process.pid);
    if (!resource.supervisor || resource.supervisor.group !== process.pid) throw new Error("supervisor-not-isolated");
    resource.members = [resource.supervisor];
  });
  send({ type: "ready" });
  const deadline = Date.now() + 12000;
  while (true) {
    if (!launched && Date.now() > deadline) stopping = true;
    await inspect();
    await delay(500);
  }
} catch (error) {
  // Leave the durable row for next-start recovery; never clear it merely because control failed.
  send({ type: "error", code: error.message });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
