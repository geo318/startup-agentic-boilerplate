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
  discover: { regex: string; min: number };
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
};

const MAX_OUTPUT = 64 * 1024;

export type DockerSandbox = { image: string };

// Throwaway container: no network, non-root, read-only root, no capabilities, bounded memory/pids.
// Only the workspace is mounted. Never privileged, never the host Docker socket.
export function dockerArgv(spec: GateSpec, cwd: string, image: string, name: string): string[] {
  return [
    "run", "--rm", "--name", name, "--network", "none", "--user", "65534:65534", "--read-only",
    "--tmpfs", "/tmp:rw,size=64m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "512m", "--pids-limit", "256", "-v", `${cwd}:/work`, "-w", "/work",
    "-e", "HOME=/tmp", "-e", "CI=1", image, ...spec.argv,
  ];
}

export function runGate(spec: GateSpec, cwd: string, snapshot: string, docker?: DockerSandbox): Promise<GateResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const name = `agentic-${spec.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [cmd, args] = docker
      ? ["docker", dockerArgv(spec, cwd, docker.image, name)] as const
      : [spec.argv[0]!, spec.argv.slice(1)] as const;
    // Minimal env: no host credentials leak into candidate code (scratch HOME, not the user's).
    // The docker client itself needs the real HOME to find its context; the container never sees it.
    const home = docker ? (process.env.HOME ?? "") : mkdtempSync(join(tmpdir(), "gate-home-"));
    const child = spawn(cmd, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home, CI: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      if (docker) spawn("docker", ["kill", name], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: home } }).on("error", () => {});
    };
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
      clearTimeout(timer);
      killGroup(); // descendants
      resolve({
        gateId: spec.id, argv: spec.argv, status, exitCode, signal, discovered,
        durationMs: Date.now() - started, snapshot, outputTail: out.slice(-MAX_OUTPUT),
      });
    };
    child.on("error", () => finish("error", null, null, null));
    child.on("close", (code, signal) => {
      if (timedOut) return finish("timeout", code, signal, null);
      const m = new RegExp(spec.discover.regex).exec(out);
      const discovered = m ? Number(m[1]) : 0;
      if (code !== 0) return finish("fail", code, signal, discovered);
      finish(Number.isFinite(discovered) && discovered >= spec.discover.min ? "pass" : "incomplete", code, signal, discovered);
    });
  });
}
