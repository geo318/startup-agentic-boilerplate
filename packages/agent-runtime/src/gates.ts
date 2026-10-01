import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Trusted definition, held by the controller. Models name a gate by id, never a command.
export type GateSpec = {
  id: string;
  argv: string[];
  timeoutMs: number;
  // Applicable gates must discover work: `regex` capture group 1 is a count read from stdout.
  discover: { regex: string; min: number }; // min 0 = no discovery needed (bootstrap commands)
  env?: Record<string, string>; // extra environment fixed by trusted policy, e.g. a package cache location
};

export type GateStatus = "pass" | "fail" | "error" | "timeout" | "incomplete";
export type GateResult = {
  gateId: string;
  argv: string[];
  status: GateStatus;
  exitCode: number | null;
  signal: string | null;
  discovered: number | null;
  durationMs: number;
  snapshot: string;
  outputTail: string;
  note?: string; // controller-added reason, e.g. a discovery regression against the baseline
};

const MAX_OUTPUT = 64 * 1024;
// Colour codes would split "Tests  518 passed" and defeat discovery; strip them before matching or reporting.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// Every running gate's process group, so cancellation can terminate the command and all descendants.
const active = new Set<() => void>();
export function killAllGates(): void {
  for (const kill of [...active]) kill();
}

export type DockerSandbox = { image: string };

// Throwaway container: no network, non-root, read-only root, no capabilities, bounded memory/pids.
// Only the workspace is mounted. Never privileged, never the host Docker socket.
export function dockerArgv(spec: GateSpec, cwd: string, image: string, name: string): string[] {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--user",
    "65534:65534",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "512m",
    "--pids-limit",
    "256",
    "-v",
    `${cwd}:/work`,
    "-w",
    "/work",
    "-e",
    "HOME=/tmp",
    "-e",
    "CI=1",
    image,
    ...spec.argv,
  ];
}

export function runGate(spec: GateSpec, cwd: string, snapshot: string, docker?: DockerSandbox): Promise<GateResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const name = `agentic-${spec.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [cmd, args] = docker
      ? (["docker", dockerArgv(spec, cwd, docker.image, name)] as const)
      : ([spec.argv[0]!, spec.argv.slice(1)] as const);
    // Minimal env: no host credentials leak into candidate code (scratch HOME, not the user's).
    // The docker client itself needs the real HOME to find its context; the container never sees it.
    const home = docker ? (process.env.HOME ?? "") : mkdtempSync(join(tmpdir(), "gate-home-"));
    const child = spawn(cmd, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home, CI: "1", NO_COLOR: "1", ...(docker ? {} : (spec.env ?? {})) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      if (docker)
        spawn("docker", ["kill", name], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: home } }).on(
          "error",
          () => {},
        );
    };
    active.add(killGroup);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, spec.timeoutMs);
    const collect = (b: Buffer) => {
      if (out.length < MAX_OUTPUT * 2) out += b.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (status: GateStatus, exitCode: number | null, signal: string | null, discovered: number | null) => {
      out = out.replace(ANSI, "");
      clearTimeout(timer);
      active.delete(killGroup);
      killGroup(); // descendants
      resolve({
        gateId: spec.id,
        argv: spec.argv,
        status,
        exitCode,
        signal,
        discovered,
        durationMs: Date.now() - started,
        snapshot,
        outputTail: out.slice(-MAX_OUTPUT),
      });
    };
    child.on("error", () => finish("error", null, null, null));
    child.on("close", (code, signal) => {
      if (timedOut) return finish("timeout", code, signal, null);
      if (code === 0 && spec.discover.min === 0) return finish("pass", code, signal, null);
      const m = new RegExp(spec.discover.regex).exec(out.replace(ANSI, ""));
      const discovered = m ? Number(m[1]) : 0;
      if (code !== 0) return finish("fail", code, signal, discovered);
      finish(
        Number.isFinite(discovered) && discovered >= spec.discover.min ? "pass" : "incomplete",
        code,
        signal,
        discovered,
      );
    });
  });
}
