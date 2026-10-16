// Process identity is checked again immediately before every signal. Never kill by port/name.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 3000 });
  if (result.error || result.status !== 0) throw new Error(`process-inspection-failed: ${command}`);
  return result.stdout.trim();
}

let boot;
export function bootId() {
  if (boot) return boot;
  if (process.platform === "linux") boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  else if (process.platform === "darwin") boot = output("sysctl", ["-n", "kern.boottime"]);
  else throw new Error(`unsupported-platform: ${process.platform}; no processes will be launched or signaled`);
  return boot;
}

export function snapshot() {
  const text = output("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="]);
  return text.split("\n").flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) return [];
    const [pid, ppid, group] = parts.slice(0, 3).map(Number);
    let start = parts.slice(3, 8).join(" ");
    if (process.platform === "linux") {
      try { start = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19]; }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return []; throw error; }
    }
    return [{ pid, ppid, group, start, boot: bootId(), zombie: parts[8].startsWith("Z") }];
  });
}

export function identity(pid, table = snapshot()) {
  return table.find((item) => item.pid === pid && !item.zombie) ?? null;
}

export function matches(expected, table = snapshot()) {
  if (!expected) return false;
  const actual = identity(expected.pid, table);
  return actual !== null && actual.start === expected.start && actual.boot === expected.boot;
}

export function members(resource, table = snapshot()) {
  const known = new Map((resource.members ?? []).filter((item) => matches(item, table)).map((item) => [item.pid, item]));
  if (matches(resource.supervisor, table)) {
    // The detached supervisor stays alive as the process-group sentinel until cleanup finishes.
    for (const item of table) if (!item.zombie && item.group === resource.supervisor.pid) known.set(item.pid, item);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of table) if (!item.zombie && !known.has(item.pid) && known.has(item.ppid)) {
      known.set(item.pid, item);
      changed = true;
    }
  }
  return [...known.values()];
}

export function signal(expected, name) {
  if (!matches(expected)) return false;
  try { process.kill(expected.pid, name); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

export function listeners(pids) {
  if (!pids.length) return [];
  const result = spawnSync("lsof", ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fn"], {
    encoding: "utf8", timeout: 3000,
  });
  if (result.error || ![0, 1].includes(result.status)) return null;
  return [...new Set(result.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1)))];
}

export function checkoutHasServer(root) {
  const listening = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", timeout: 3000 });
  if (listening.error || ![0, 1].includes(listening.status)) return null;
  const pids = listening.stdout.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => line.slice(1));
  if (!pids.length) return false;
  const cwd = spawnSync("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 3000 });
  if (cwd.error || ![0, 1].includes(cwd.status)) return null;
  return cwd.stdout.split("\n").some((line) => line === `n${root}` || line.startsWith(`n${root}/`));
}
