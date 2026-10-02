import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  outputLog?: string;
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

export function runGate(spec: GateSpec, cwd: string, snapshot: string, outputLog?: string): Promise<GateResult> {
  const started = Date.now();
  if (outputLog) mkdirSync(dirname(outputLog), { recursive: true });
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let finished = false;
    let discoveredCount = 0;
    const discovery = new RegExp(spec.discover.regex, "g");
    const [cmd, args] = [spec.argv[0]!, spec.argv.slice(1)];
    // Minimal env: candidate code receives a scratch HOME, not host credentials.
    const home = mkdtempSync(join(tmpdir(), "gate-home-"));
    const child = spawn(cmd, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home, CI: "1", NO_COLOR: "1", ...(spec.env ?? {}) },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    active.add(killGroup);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, spec.timeoutMs);
    const collect = (b: Buffer) => {
      if (outputLog) appendFileSync(outputLog, b);
      out += b.toString();
      for (const m of out.replace(ANSI, "").matchAll(discovery)) {
        const count = Number(m[1]);
        if (Number.isFinite(count)) discoveredCount = count;
      }
      out = out.slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (status: GateStatus, exitCode: number | null, signal: string | null, discovered: number | null) => {
      if (finished) return;
      finished = true;
      out = out.replace(ANSI, "");
      clearTimeout(timer);
      active.delete(killGroup);
      killGroup(); // descendants
      rmSync(home, { recursive: true, force: true });
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
        ...(outputLog ? { outputLog } : {}),
      });
    };
    child.on("error", () => finish("error", null, null, null));
    child.on("close", (code, signal) => {
      if (timedOut) return finish("timeout", code, signal, null);
      if (code === 0 && spec.discover.min === 0) return finish("pass", code, signal, null);
      const discovered = discoveredCount;
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
