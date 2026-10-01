#!/usr/bin/env node
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Run } from "../run.ts";
import { fileURLToPath } from "node:url";
import { pinProject } from "../pin.ts";
import { loadSecrets } from "../secrets.ts";
import * as c from "./commands.ts";

const USAGE = `agentic <command>
  pin   (writes .agents/runtime.json pointing at this runtime checkout)
  doctor | validate [contract.json...]
  qualify <profile> [--owner-declare architecture|review|action-protocol]
  task create <contract.json> | run <id> | status <id> | approve <id> | accept <id> | cancel <id> | verify <id> | export <id>
  jev status | report | calibrate --family <f> --labels <file>
  report <id>
Options: --project <dir> (default: cwd). Controller state: $AGENTIC_HOME (default ~/.agentic).`;

const argv = process.argv.slice(2);
const flag = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
let active: Run | undefined;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const env: c.Env = {
  home: process.env.AGENTIC_HOME ?? join(homedir(), ".agentic"),
  project: resolve(flag("--project") ?? process.cwd()),
  out: (s) => console.log(s),
  operatorTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: (q) => rl.question(q),
  user: userInfo().username,
  secrets: (() => { try { return loadSecrets(process.env.AGENTIC_HOME ?? join(homedir(), ".agentic")); } catch (e) { console.error(String((e as Error).message)); return {}; } })(),
  onRun: (r) => { active = r; },
};
process.on("SIGINT", () => { active?.cancel(); process.exit(130); });

async function main(): Promise<number> {
  const [cmd, sub, arg] = argv;
  switch (cmd) {
    case "pin": {
      const pin = pinProject(env.project, resolve(fileURLToPath(import.meta.url), "..", "..", ".."));
      console.log(`pinned ${pin.runtimePath} @ ${pin.treeHash.slice(0, 12)} in ${env.project}/.agents/runtime.json`);
      return 0;
    }
    case "doctor": return c.doctor(env);
    case "validate": return c.validateFiles(env, argv.slice(1).filter((a) => !a.startsWith("--") && a !== env.project));
    case "qualify": return c.qualify(env, sub ?? "", flag("--owner-declare") as any);
    case "report": return c.report(env, sub ?? "");
    case "jev":
      if (sub === "status") return c.jevStatus(env);
      if (sub === "report") return c.jevReport(env);
      if (sub === "calibrate") return c.jevCalibrate(env, (flag("--family") ?? "") as any, flag("--labels") ?? "");
    case "task":
      if (sub === "create") return c.taskCreate(env, resolve(arg ?? ""));
      if (sub === "run") return c.taskRun(env, arg ?? "");
      if (sub === "status") return c.taskStatus(env, arg ?? "");
      if (sub === "approve") return c.taskApprove(env, arg ?? "");
      if (sub === "accept") return c.taskAccept(env, arg ?? "");
      if (sub === "cancel") return c.taskCancel(env, arg ?? "");
      if (sub === "export") return c.exportPatch(env, arg ?? "");
      if (sub === "verify") return c.verifyTask(env, arg ?? "");
  }
  console.log(USAGE);
  return 1;
}

main().then((code) => { rl.close(); process.exit(code); }, (e) => {
  console.error(e instanceof c.CliError ? e.message : e);
  rl.close();
  process.exit(e instanceof c.CliError ? e.code : 1);
});
