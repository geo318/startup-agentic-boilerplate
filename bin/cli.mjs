#!/usr/bin/env node
// project-setup install [dir|--global] [--link] [--force]  → copy the skill into .agents/skills
// project-setup sync [dir] [--dry-run]                      → take in template updates
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skill = resolve(dirname(fileURLToPath(import.meta.url)), "../project-setup");
const [cmd, ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith("-"));
const dir = rest.find((a) => !a.startsWith("-"));
const fail = (msg) => { console.error(msg); process.exit(1); };

if (cmd === "install") {
  const target = flags.includes("--global") || flags.includes("-g") ? homedir() : resolve(dir ?? fail("usage: project-setup install <dir>|--global [--link] [--force]"));
  const dest = join(target, ".agents/skills/project-setup");
  const claude = join(target, ".claude/skills/project-setup");
  for (const p of [dest, claude]) {
    if (!existsSync(p) && !lstatSync(p, { throwIfNoEntry: false })) continue;
    if (!flags.includes("--force")) fail(`already installed: ${p} (rerun with --force to replace)`);
    rmSync(p, { recursive: true, force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });
  mkdirSync(dirname(claude), { recursive: true });
  if (flags.includes("--link")) symlinkSync(skill, dest); else cpSync(skill, dest, { recursive: true });
  symlinkSync("../../.agents/skills/project-setup", claude);
  console.log(`installed → ${dest}\nClaude Code link → ${claude}`);
} else if (cmd === "sync") {
  const target = resolve(dir ?? ".");
  const answers = join(target, "docs/archive/project-setup.answers.json");
  if (!existsSync(answers)) fail(`not a project-setup project (missing ${answers})`);
  const args = [join(skill, "scripts/scaffold.mjs"), "--answers", answers, "--target", target, "--sync"];
  if (flags.includes("--dry-run")) args.push("--dry-run");
  process.exit(spawnSync(process.execPath, args, { stdio: "inherit" }).status ?? 1);
} else {
  fail("usage: project-setup install <dir>|--global [--link] [--force]\n       project-setup sync [dir] [--dry-run]");
}
