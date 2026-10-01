// Worktree ↔ branch management, exercised against real git repositories with a local bare "origin".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scaffold = join(root, "project-setup/scripts/scaffold.mjs");
const answers = join(root, "test/fixtures/answers.json");
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "wt-")));

// Render the real templates once (DEFAULT_BRANCH is substituted), then reuse the scripts in every test repo.
const rendered = tmp();
spawnSync(process.execPath, [scaffold, "--answers", answers, "--target", rendered]);
const SCRIPTS = join(rendered, "scripts/git");

const run = (cwd, ...a) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
const must = (cwd, ...a) => {
  const r = run(cwd, ...a);
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const wt = (cwd, ...a) =>
  spawnSync(process.execPath, [join(cwd, "scripts/git/worktrees.mjs"), ...a], { cwd, encoding: "utf8" });

function repo() {
  const base = tmp();
  const origin = join(base, "origin.git");
  const proj = join(base, "proj");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["clone", "-q", origin, proj]);
  must(proj, "checkout", "-q", "-b", "main");
  mkdirSync(join(proj, "scripts"), { recursive: true });
  cpSync(SCRIPTS, join(proj, "scripts/git"), { recursive: true });
  writeFileSync(join(proj, "README.md"), "x\n");
  must(proj, "add", "-A");
  must(proj, "commit", "-qm", "init");
  must(proj, "push", "-q", "-u", "origin", "main");
  return { base, proj, origin, wtDir: join(base, "proj.worktrees") };
}
const commitIn = (dir, file, msg = "work") => {
  writeFileSync(join(dir, file), `${file}\n`);
  must(dir, "add", "-A");
  must(dir, "commit", "-qm", msg);
};
// create a worktree and (optionally) get it into a given state
function make(r, branch, state = "clean") {
  const out = wt(r.proj, "new", branch, "--no-fetch");
  assert.equal(out.status, 0, out.stderr + out.stdout);
  const dir = join(r.wtDir, branch.replaceAll("/", "-"));
  if (state !== "clean") commitIn(dir, `${branch.replaceAll("/", "-")}.txt`);
  if (state === "merged" || state === "pushed" || state === "gone") must(dir, "push", "-q", "-u", "origin", branch);
  if (state === "merged") {
    must(r.proj, "merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch);
    must(r.proj, "push", "-q", "origin", "main");
  }
  return dir;
}

test("new: creates the branch at the standard sibling path; the slug maps slashes to dashes; base is respected", () => {
  const r = repo();
  const out = wt(r.proj, "new", "feat/add-login", "--no-fetch");
  assert.equal(out.status, 0, out.stderr);
  const dir = join(r.wtDir, "feat-add-login");
  assert.ok(existsSync(join(dir, "README.md")));
  assert.equal(must(dir, "rev-parse", "--abbrev-ref", "HEAD"), "feat/add-login");
  assert.equal(must(dir, "rev-parse", "HEAD"), must(r.proj, "rev-parse", "origin/main"));
  assert.match(out.stdout, /created feat\/add-login from origin\/main/);
});

test("new: rejects bad branch names, existing branches, taken slugs and existing paths, creating nothing", () => {
  const r = repo();
  for (const bad of ["Feature/X", "changes", "feat/Has Space", "feat/"]) {
    const o = wt(r.proj, "new", bad, "--no-fetch");
    assert.equal(o.status, 1, bad);
    assert.equal(existsSync(r.wtDir), false, bad);
  }
  make(r, "feat/one");
  assert.match(wt(r.proj, "new", "feat/one", "--no-fetch").stderr, /already exists/);
  must(r.proj, "branch", "fix/two");
  assert.match(wt(r.proj, "new", "fix/two", "--no-fetch").stderr, /already exists/);
  must(r.proj, "branch", "feat-x/y"); // slug "feat-x-y" ...
  make(r, "feat/x-y"); // ... is taken by a different branch only when both are checked out: here feat/x-y → feat-x-y is free
  mkdirSync(join(r.wtDir, "feat-occupied"), { recursive: true });
  assert.match(wt(r.proj, "new", "feat/occupied", "--no-fetch").stderr, /already exists/);
  assert.match(wt(r.proj, "new", "feat/nope", "--base", "origin/missing", "--no-fetch").stderr, /does not exist/);
  assert.equal(run(r.proj, "show-ref", "--verify", "--quiet", "refs/heads/feat/nope").status, 1);
});

test("slug collisions between different branches are refused", () => {
  const r = repo();
  make(r, "feat/a-b");
  const o = wt(r.proj, "new", "feat-a/b", "--no-fetch"); // not a valid type, still must not reach git
  assert.equal(o.status, 1);
  must(r.proj, "worktree", "add", "-q", "-b", "chore/a-b", join(r.base, "elsewhere"), "main");
  const dup = wt(r.proj, "new", "chore/a-b", "--no-fetch");
  assert.equal(dup.status, 1);
});

test("list shows main, branches, dirty/unpushed/merged state; --json is machine-readable", () => {
  const r = repo();
  const d = make(r, "feat/dirty-one");
  writeFileSync(join(d, "scratch.txt"), "x");
  make(r, "feat/unpushed-one", "unpushed");
  const text = wt(r.proj, "list").stdout;
  assert.match(text, /main .*\[main/);
  assert.match(text, /feat\/dirty-one .*dirty/);
  assert.match(text, /feat\/unpushed-one .*1 unpushed/);
  const json = JSON.parse(wt(r.proj, "list", "--json").stdout);
  assert.equal(json.length, 3);
  assert.equal(json.find((x) => x.branch === "feat/dirty-one").dirty, true);
  assert.equal(json[0].main, true);
});

test("clean: only clean + pushed + unlocked + merged worktrees go; everything else is kept with its reason; dry run is the default", () => {
  const r = repo();
  const merged = make(r, "feat/merged-one", "merged");
  const dirty = make(r, "feat/dirty-merged", "merged");
  writeFileSync(join(dirty, "untracked.txt"), "x");
  const unpushed = make(r, "feat/unpushed-one", "unpushed");
  const pushed = make(r, "feat/pushed-unmerged", "pushed");
  const locked = make(r, "feat/locked-merged", "merged");
  must(r.proj, "worktree", "lock", locked);
  const dry = wt(r.proj, "clean");
  assert.match(dry.stdout, /would remove feat\/merged-one/);
  assert.match(dry.stdout, /dry run: nothing changed/);
  assert.ok(existsSync(merged));
  const out = wt(r.proj, "clean", "--yes").stdout;
  assert.match(out, /removed feat\/merged-one and deleted its branch/);
  assert.equal(existsSync(merged), false);
  assert.equal(run(r.proj, "show-ref", "--verify", "--quiet", "refs/heads/feat/merged-one").status, 1);
  assert.match(out, /keep\s+feat\/dirty-merged: uncommitted or untracked changes/);
  assert.match(out, /keep\s+feat\/unpushed-one: 1 commit\(s\) not on any remote/);
  assert.match(out, /keep\s+feat\/pushed-unmerged: not merged into origin\/main/);
  assert.match(out, /keep\s+feat\/locked-merged: locked/);
  for (const d of [dirty, unpushed, pushed, locked]) assert.ok(existsSync(d), d);
  assert.equal(run(r.proj, "show-ref", "--verify", "--quiet", "refs/heads/feat/dirty-merged").status, 0);
  assert.ok(existsSync(join(dirty, "untracked.txt"))); // the person's work is untouched
});

test("clean never removes the main checkout or the directory you are standing in", () => {
  const r = repo();
  const merged = make(r, "feat/merged-here", "merged");
  const inside = wt(merged, "clean", "--yes");
  assert.match(inside.stdout, /keep\s+feat\/merged-here: you are inside it/);
  assert.ok(existsSync(merged));
  assert.ok(existsSync(join(r.proj, "README.md")));
});

test("squash-merged branches (remote deleted, history differs) are listed for a person, never force-deleted", () => {
  const r = repo();
  const sq = make(r, "feat/squashed-one", "gone");
  commitIn(r.proj, "squashed-equivalent.txt", "squash of feat/squashed-one"); // main gets a different commit, as a squash merge would
  must(r.proj, "push", "-q", "origin", "main");
  must(r.proj, "push", "-q", "origin", "--delete", "feat/squashed-one");
  must(r.proj, "fetch", "-q", "--prune");
  const out = wt(r.proj, "clean", "--yes").stdout;
  assert.match(out, /keep\s+feat\/squashed-one:.*upstream deleted but not merged by history/);
  assert.ok(existsSync(sq));
  assert.equal(run(r.proj, "show-ref", "--verify", "--quiet", "refs/heads/feat/squashed-one").status, 0);
});

test("prune repairs a worktree whose directory was deleted by hand; list and clean report it", () => {
  const r = repo();
  const d = make(r, "feat/rm-rf-victim");
  rmSync(d, { recursive: true, force: true });
  assert.match(wt(r.proj, "list").stdout, /MISSING/);
  assert.match(wt(r.proj, "clean", "--yes").stdout, /keep\s+feat\/rm-rf-victim: directory is missing \(run prune\)/);
  wt(r.proj, "prune");
  assert.doesNotMatch(wt(r.proj, "list").stdout, /rm-rf-victim/);
});

test("doctor flags a misplaced path, a bad branch name, a detached HEAD, stale merged leftovers and a dirty main checkout; --strict fails", () => {
  const r = repo();
  assert.match(wt(r.proj, "doctor").stdout, /ok: 1 worktree/);
  make(r, "feat/merged-leftover", "merged");
  const stray = join(r.base, "stray-place");
  must(r.proj, "worktree", "add", "-q", "-b", "Bad_Name", stray, "main");
  const detached = join(r.base, "detached-here");
  must(r.proj, "worktree", "add", "-q", "--detach", detached, "main");
  writeFileSync(join(r.proj, "dirty-main.txt"), "x");
  const out = wt(r.proj, "doctor");
  assert.match(out.stdout, /main checkout has uncommitted changes/);
  assert.match(out.stdout, /feat\/merged-leftover: merged and clean: remove it/);
  assert.match(out.stdout, /Bad_Name: branch name violates the conventions/);
  assert.match(out.stdout, /Bad_Name: .*is outside/);
  assert.match(out.stdout, /detached HEAD/);
  assert.equal(out.status, 0); // warnings by default
  assert.equal(wt(r.proj, "doctor", "--strict").status, 1);
});

test("the script cannot force anything: no --force, no -f, no `git branch -D` among the git arguments it issues", () => {
  const src = readFileSync(join(SCRIPTS, "worktrees.mjs"), "utf8");
  assert.doesNotMatch(src, /["'`]--force["'`]|["'`]-f["'`]|["'`]-D["'`]|["'`]--hard["'`]|reset/);
  assert.match(src, /"worktree", "remove", r\.path\]/);
  assert.match(src, /"branch", "-d"/);
});

test("rendered rules: delivery standard has the Worktrees section and AGENTS.md points to it; the docs check still sees only unfilled markers", () => {
  const delivery = readFileSync(join(rendered, "context/standards/delivery.md"), "utf8");
  assert.match(delivery, /## Worktrees/);
  assert.match(delivery, /`feat\/add-login` → `feat-add-login`/);
  assert.match(delivery, /git worktree remove --force/);
  assert.match(readFileSync(join(rendered, "AGENTS.md"), "utf8"), /delivery\.md#worktrees/);
  const check = spawnSync(process.execPath, [join(rendered, "scripts/checks/docs-check.mjs"), "--root", rendered], {
    encoding: "utf8",
  });
  assert.doesNotMatch(check.stdout + check.stderr, /broken|anchor|worktrees/i);
  assert.equal(basename(SCRIPTS), "git");
});
