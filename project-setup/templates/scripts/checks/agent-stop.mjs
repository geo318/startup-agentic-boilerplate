#!/usr/bin/env node
// Claude Code Stop hook: before the agent hands back, run the fast checks on what it changed and
// return failures to it (exit 2), so code and docs are fixed in the same turn, not at push time.
//
//   Wired in .claude/settings.json → hooks.Stop. Reads the hook payload on stdin.
//
// Runs under both Node and Bun; no dependencies.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_LINES = 30;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|json)$/;

function run(label, command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status === 0) {
    return null;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.includes(" WARN "));
  const shown = output.slice(0, MAX_LINES);
  if (output.length > MAX_LINES) {
    shown.push(`… ${output.length - MAX_LINES} more lines; run it yourself for the rest`);
  }
  return `$ ${label}\n${shown.join("\n")}`;
}

function hasBase() {
  return ["origin/HEAD", "origin/main", "origin/master", "main", "master"].some(
    (ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref]).status === 0,
  );
}

function branchChanges() {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const result = spawnSync("git", ["diff", "--name-only", `${ref}...HEAD`], { encoding: "utf8" });
    if (result.status === 0) {
      return result.stdout.split("\n").filter(Boolean);
    }
  }
  return [];
}

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  // Already sent back once this turn: let the agent stop instead of looping.
  if (payload.stop_hook_active === true) {
    return;
  }
  process.chdir(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  const committed = branchChanges();
  const changed = (status.stdout ?? "")
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
    .concat(committed);
  if (changed.length === 0) {
    return;
  }

  const failures = [run("docs-check", process.execPath, ["scripts/checks/docs-check.mjs"])];
  const fallow = join("node_modules", ".bin", "fallow");
  if (existsSync(fallow) && changed.some((path) => CODE_FILE.test(path))) {
    // audit judges only what this branch introduced, but needs a base; a repo with no remote
    // yet is new, so the whole tree must be clean anyway.
    const args = hasBase() ? ["audit", "--quiet"] : ["--quiet"];
    failures.push(run(`fallow ${args.join(" ")}`, fallow, args));
  }

  const found = failures.filter((failure) => failure !== null);
  if (found.length > 0) {
    console.error(
      `Checks failed on your changes. Fix them before finishing:\n\n${found.join("\n\n")}`,
    );
    process.exit(2);
  }
}

main();
