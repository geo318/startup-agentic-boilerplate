#!/usr/bin/env node
// Worktree ↔ branch management (context/standards/delivery.md → Worktrees).
//
//   worktrees.mjs list [--json]
//   worktrees.mjs new <branch> [--base <ref>] [--no-fetch]
//   worktrees.mjs clean [--yes] [--base <ref>]      dry run unless --yes
//   worktrees.mjs prune
//   worktrees.mjs doctor [--strict]
//
// Safe by construction: never uses --force, never `git branch -D`, never touches the main checkout or the directory it
// is run from, and removes a worktree only when it is clean, fully pushed, unlocked, and its branch is merged into the base.
// Runs under both Node and Bun; no dependencies.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BRANCH = "{{DEFAULT_BRANCH}}";
const DEFAULT_BASE = `origin/${DEFAULT_BRANCH}`;
const STALE_DAYS = 14;
const here = dirname(fileURLToPath(import.meta.url));

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const fail = (message) => {
  console.error(`worktrees: ${message}`);
  process.exit(1);
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
export const slugOf = (branch) => branch.replaceAll("/", "-");

function listWorktrees() {
  const r = git(["worktree", "list", "--porcelain"]);
  if (!r.ok) fail(`not a git repository (${r.err})`);
  const entries = [];
  for (const block of r.out.split("\n\n")) {
    const e = { path: "", branch: null, head: "", detached: false, locked: false, prunable: false, bare: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) e.path = line.slice(9);
      else if (line.startsWith("HEAD ")) e.head = line.slice(5);
      else if (line.startsWith("branch ")) e.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") e.detached = true;
      else if (line === "bare") e.bare = true;
      else if (line.startsWith("locked")) e.locked = true;
      else if (line.startsWith("prunable")) e.prunable = true;
    }
    if (e.path) entries.push(e);
  }
  return entries.map((e, i) => ({ ...e, main: i === 0 }));
}

function inspect(e, base) {
  const missing = !existsSync(e.path);
  const info = { ...e, missing, dirty: false, unpushed: 0, merged: false, upstreamGone: false, ageDays: null };
  if (missing || e.bare) return info;
  info.dirty = git(["status", "--porcelain"], e.path).out.length > 0;
  info.unpushed = Number(git(["rev-list", "--count", "HEAD", "--not", "--remotes"], e.path).out) || 0;
  info.merged = git(["merge-base", "--is-ancestor", "HEAD", base], e.path).ok;
  if (e.branch) {
    info.upstreamGone = git(["for-each-ref", "--format=%(upstream:track)", `refs/heads/${e.branch}`], e.path).out.includes("gone");
  }
  const t = Number(git(["log", "-1", "--format=%ct"], e.path).out);
  info.ageDays = t ? Math.floor((Date.now() / 1000 - t) / 86400) : null;
  return info;
}

function repoRoot(entries) {
  return entries[0].path;
}
const standardDir = (root) => join(dirname(root), `${basename(root)}.worktrees`);
const isStandardPath = (root, p) => {
  const rp = real(p);
  return rp.startsWith(real(standardDir(root)) + sep) || rp.includes(`${sep}.claude${sep}worktrees${sep}`);
};

function checkBranchName(name) {
  const r = spawnSync(process.execPath, [join(here, "conventions.mjs"), "branch", name], { encoding: "utf8" });
  return { ok: r.status === 0, message: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const base = opt("--base") ?? DEFAULT_BASE;

if (cmd === "list") {
  const rows = listWorktrees().map((e) => inspect(e, base));
  if (flag("--json")) console.log(JSON.stringify(rows, null, 2));
  else
    for (const r of rows) {
      const tags = [r.main && "main", r.locked && "locked", r.missing && "MISSING", r.detached && "detached", r.dirty && "dirty", r.unpushed > 0 && `${r.unpushed} unpushed`, r.merged && !r.main && "merged", r.upstreamGone && "upstream gone", r.ageDays !== null && `${r.ageDays}d`].filter(Boolean);
      console.log(`${(r.branch ?? "(detached)").padEnd(34)} ${r.path}  [${tags.join(", ")}]`);
    }
} else if (cmd === "new") {
  const branch = args[1];
  if (!branch || branch.startsWith("--")) fail("usage: worktrees.mjs new <type>/<kebab-name> [--base <ref>] [--no-fetch]");
  const name = checkBranchName(branch);
  if (!name.ok) fail(`branch name rejected by the conventions:\n${name.message}`);
  const entries = listWorktrees();
  const root = repoRoot(entries);
  if (git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok) fail(`branch ${branch} already exists (a branch lives in at most one worktree)`);
  const slug = slugOf(branch);
  const clash = entries.find((e) => e.branch && slugOf(e.branch) === slug);
  if (clash) fail(`slug "${slug}" is already used by branch ${clash.branch}`);
  const path = join(standardDir(root), slug);
  if (existsSync(path)) fail(`${path} already exists`);
  if (!flag("--no-fetch") && base.startsWith("origin/")) {
    const f = git(["fetch", "origin", base.slice(7)], root);
    if (!f.ok) fail(`could not fetch ${base} (use --no-fetch to branch from the local ref): ${f.err}`);
  }
  if (!git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], root).ok) fail(`base ${base} does not exist`);
  const add = git(["worktree", "add", "--no-track", "-b", branch, path, base], root);
  if (!add.ok) fail(add.err);
  console.log(`created ${branch} from ${base}\n${path}\nnext: cd ${path}`);
} else if (cmd === "clean") {
  const here_ = real(process.cwd());
  const rows = listWorktrees().map((e) => inspect(e, base));
  const apply = flag("--yes");
  let removed = 0;
  for (const r of rows) {
    if (r.main) continue;
    const label = r.branch ?? r.path;
    const reasons = [];
    if (r.missing) reasons.push("directory is missing (run prune)");
    if (r.locked) reasons.push("locked");
    if (!r.missing && (here_ === real(r.path) || here_.startsWith(real(r.path) + sep))) reasons.push("you are inside it");
    if (r.detached || !r.branch) reasons.push("detached HEAD");
    if (r.dirty) reasons.push("uncommitted or untracked changes");
    if (r.unpushed > 0) reasons.push(`${r.unpushed} commit(s) not on any remote`);
    if (!r.merged && !r.missing && r.branch) reasons.push(r.upstreamGone ? `upstream deleted but not merged by history (squash merge?): confirm the PR was merged, then remove it yourself: git worktree remove ${r.path} && git branch -D ${r.branch}` : `not merged into ${base}`);
    if (reasons.length) {
      console.log(`keep   ${label}: ${reasons.join("; ")}`);
      continue;
    }
    if (!apply) {
      console.log(`would remove ${label} (${r.path}) and its branch`);
      continue;
    }
    const rm = git(["worktree", "remove", r.path]);
    if (!rm.ok) {
      console.log(`keep   ${label}: git refused to remove it (${rm.err})`);
      continue;
    }
    const del = git(["branch", "-d", r.branch]);
    console.log(`removed ${label}${del.ok ? " and deleted its branch" : ` (branch kept: ${del.err})`}`);
    removed += 1;
  }
  if (apply) git(["worktree", "prune"]);
  console.log(apply ? `${removed} worktree(s) removed.` : "dry run: nothing changed. Re-run with --yes to apply.");
} else if (cmd === "prune") {
  const before = listWorktrees().filter((e) => !existsSync(e.path)).length;
  const r = git(["worktree", "prune", "-v"]);
  console.log(r.out || r.err || `${before} stale record(s) pruned`);
} else if (cmd === "doctor") {
  const entries = listWorktrees();
  const root = repoRoot(entries);
  const rows = entries.map((e) => inspect(e, base));
  const problems = [];
  for (const r of rows) {
    const label = r.branch ?? r.path;
    if (r.main) {
      if (r.branch !== DEFAULT_BRANCH) problems.push(`main checkout is on ${r.branch ?? "a detached HEAD"}, expected ${DEFAULT_BRANCH}`);
      if (r.dirty) problems.push("main checkout has uncommitted changes (do work in a worktree)");
      continue;
    }
    if (r.missing) problems.push(`${label}: directory is missing (run prune)`);
    if (r.detached || !r.branch) problems.push(`${r.path}: detached HEAD (a worktree should track one branch)`);
    if (r.branch) {
      const name = checkBranchName(r.branch);
      if (!name.ok) problems.push(`${label}: branch name violates the conventions`);
      if (!r.missing && basename(r.path) !== slugOf(r.branch) && isStandardPath(root, r.path)) problems.push(`${label}: directory name should be "${slugOf(r.branch)}"`);
    }
    if (!r.missing && !isStandardPath(root, r.path)) problems.push(`${label}: ${r.path} is outside ${standardDir(root)} and .claude/worktrees`);
    if (r.ageDays !== null && r.ageDays >= STALE_DAYS && !r.merged) problems.push(`${label}: stale (${r.ageDays} days without a commit) and not merged`);
    if (r.merged && !r.dirty && r.unpushed === 0) problems.push(`${label}: merged and clean: remove it (clean)`);
  }
  for (const p of problems) console.log(`warn  ${p}`);
  console.log(problems.length ? `${problems.length} finding(s).` : `ok: ${entries.length} worktree(s), nothing to fix.`);
  process.exit(problems.length && flag("--strict") ? 1 : 0);
} else {
  console.log("usage: worktrees.mjs list [--json] | new <branch> [--base <ref>] [--no-fetch] | clean [--yes] | prune | doctor [--strict]");
  process.exit(cmd ? 1 : 0);
}
