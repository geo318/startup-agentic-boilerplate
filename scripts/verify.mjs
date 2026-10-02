#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = fileURLToPath(new URL("../packages/agent-runtime/", import.meta.url));
const checks = [
  [root, process.execPath, ["--test", "test/*.test.mjs"]],
  [runtime, "npm", ["test"]],
  [runtime, "npm", ["run", "typecheck"]],
  [runtime, "npm", ["run", "lint"]],
  [runtime, "npm", ["run", "format:check"]],
  [runtime, process.execPath, ["src/cli/main.ts", "arch", "check", "--project", "."]],
];
for (const [cwd, cmd, args] of checks) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}
console.log("Verification passed: setup, runtime, types, lint, formatting, architecture.");
