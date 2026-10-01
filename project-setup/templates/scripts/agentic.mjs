#!/usr/bin/env node
// Launcher for the pinned agent-runtime. Nothing here orchestrates anything: it checks that the runtime on
// disk is the one recorded in .agents/runtime.json, then runs it with the terminal attached.
//
//   node scripts/agentic.mjs <command>        (see: node scripts/agentic.mjs)
//
// Pin or re-pin from the runtime checkout:  node <runtime>/src/cli/main.ts pin --project <this repo>
// Runs under Node >= 22.18 (the runtime is TypeScript executed by type stripping).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
  console.error(`[agentic] ${message}`);
  process.exit(1);
};

const pinFile = join(root, ".agents", "runtime.json");
if (!existsSync(pinFile)) {
  fail("no runtime pinned. From the runtime checkout run: node <runtime>/src/cli/main.ts pin --project " + root);
}
let pin;
try {
  pin = JSON.parse(readFileSync(pinFile, "utf8"));
} catch {
  fail(`${pinFile} is not valid JSON`);
}
if (typeof pin.runtimePath !== "string" || !/^[0-9a-f]{64}$/.test(pin.treeHash ?? "")) {
  fail(`${pinFile} needs runtimePath and treeHash`);
}
const runtime = resolve(root, pin.runtimePath);

// Must stay identical to treeHash() in the runtime's src/pin.ts.
function listFiles(dir, prefix, pattern) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) return listFiles(join(dir, e.name), rel, pattern);
    return e.isFile() && pattern.test(e.name) ? [[rel, join(dir, e.name)]] : [];
  });
}
const files = [
  ...listFiles(join(runtime, "src"), "src", /\.ts$/),
  ...listFiles(join(runtime, "..", "..", "schemas"), "schemas", /\.json$/),
  ...(existsSync(join(runtime, "package.json")) ? [["package.json", join(runtime, "package.json")]] : []),
].sort(([a], [b]) => (a < b ? -1 : 1));
const actual = createHash("sha256")
  .update(files.map(([rel, abs]) => `${rel}\0${createHash("sha256").update(readFileSync(abs)).digest("hex")}`).join("\n"))
  .digest("hex");
if (actual !== pin.treeHash) {
  fail(`runtime at ${runtime} differs from the pinned version. Review the change, then re-pin (the old pin is not silently replaced).`);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) fail(`Node >= 22.18 required (found ${process.versions.node})`);

const args = process.argv.slice(2);
const forwarded = args.includes("--project") ? args : [...args, "--project", root];
const result = spawnSync(process.execPath, [join(runtime, "src", "cli", "main.ts"), ...forwarded], { stdio: "inherit" });
process.exit(result.status ?? 1);
