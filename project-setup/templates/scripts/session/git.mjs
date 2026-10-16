import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkoutHasServer } from "./processes.mjs";
import { git, keyOf, lock, load, safePath, sessionFor, touch, update } from "./state.mjs";

const DEFAULT_BRANCH = "{{DEFAULT_BRANCH}}";

function value(ctx, args) { const result = git(ctx.root, args, 3000); return result.status === 0 ? result.stdout.trim() : ""; }
function current(ctx) { return { branch: value(ctx, ["symbolic-ref", "--short", "-q", "HEAD"]), head: value(ctx, ["rev-parse", "--verify", "HEAD"]) }; }
function ancestor(ctx, a, b) { return git(ctx.root, ["merge-base", "--is-ancestor", a, b], 3000).status === 0; }

export async function begin(ctx, options) {
  const intent = options.intent ?? "fresh";
  if (!["fresh", "continue", "target"].includes(intent)) throw new Error("invalid-intent");
  if (intent !== "fresh" && !options.reason) throw new Error("continuity-reason-required");
  const id = options.session ?? randomUUID();
  return lock(ctx, "git", async () => {
    let session = await update(ctx, (state) => {
      const item = sessionFor(state, id, ctx.root, options.turn);
      if (item.active && options.turn && item.turn !== options.turn) item.active = false;
      touch(state, item, options.turn || (item.active ? item.turn : randomUUID()));
      return { ...item };
    });
    const observed = current(session.initialized ? { ...ctx, root: session.checkout } : ctx);
    let decision;
    let checkout = session.initialized ? session.checkout : ctx.root;
    let inspection;
    const outcome = (code, reason) => ({ code, reason, ...observed });
    if (session.initialized) {
      decision = outcome(session.git?.head === observed.head && session.git?.branch === observed.branch ? "already-initialized" : "preserved-checkout-moved", "This thread was already initialized; Git refresh is not repeated.");
    } else if (!ctx.inGit) decision = outcome("not-applicable", "No Git repository.");
    else if (!observed.head) decision = outcome("uninitialized", "No initial commit.");
    else if (intent === "continue" || (intent !== "target" && ["resume", "compact", "fork", "clear"].includes(session.source))) decision = outcome("preserved-context", options.reason || `Session source: ${session.source}`);
    else {
      const status = git(ctx.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], 3000);
      if (status.status !== 0) throw new Error("git-status-unavailable");
      const operations = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START", "sequencer"];
      const inOperation = operations.some((name) => {
        const path = value(ctx, ["rev-parse", "--path-format=absolute", "--git-path", name]);
        return path && existsSync(path);
      });
      const state = load(ctx);
      const busy = Object.entries(state.sessions).some(([key, item]) => key !== keyOf(id) && item.checkout === ctx.root && item.active && item.expires > Date.now()) || Object.values(state.resources).some((item) => item.checkout === ctx.root && item.owned);
      const server = checkoutHasServer(ctx.root);
      if (inOperation) decision = outcome("preserved-operation", "A Git operation is in progress.");
      else if (status.stdout && !options.isolate) decision = outcome("preserved-dirty", "Tracked, staged, or untracked work exists.");
      else if (!observed.branch && !options.isolate && intent !== "target") decision = outcome("preserved-detached", "Detached checkout.");
      else if (server === null && !options.isolate) decision = outcome("preserved-unverified-processes", "Install lsof to verify that no server uses this checkout.");
      else if (intent === "target") {
        if (!options.ref || options.ref.startsWith("-") || !value(ctx, ["rev-parse", "--verify", "--end-of-options", `${options.ref}^{commit}`])) throw new Error("invalid-target-ref");
        if (status.stdout || busy || server) decision = outcome("preserved-busy", "Requested ref cannot replace a checkout with active work.");
        else if (git(ctx.root, ["switch", "--detach", options.ref]).status !== 0) throw new Error("target-switch-failed");
        else decision = { code: "target-selected", reason: options.reason, ...current(ctx) };
      }
      else {
        const remote = options.remote || value(ctx, ["config", `branch.${DEFAULT_BRANCH}.remote`]) || "origin";
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remote) || !value(ctx, ["remote"]).split("\n").includes(remote)) decision = outcome("missing-remote", "The configured remote does not exist.");
        else if (git(ctx.root, ["check-ref-format", "--branch", DEFAULT_BRANCH], 3000).status !== 0) throw new Error("invalid-default-branch");
        else if (git(ctx.root, ["fetch", "--no-tags", remote, `+refs/heads/${DEFAULT_BRANCH}:refs/remotes/${remote}/${DEFAULT_BRANCH}`]).status !== 0) decision = outcome("unverified-offline", "Fetch failed, timed out, or the remote default branch is missing; freshness is unverified.");
        else {
          const base = `refs/remotes/${remote}/${DEFAULT_BRANCH}`;
          const worktrees = value(ctx, ["worktree", "list", "--porcelain"]);
          const mainElsewhere = worktrees.split("\n\n").some((block) => block.split("\n").includes(`branch refs/heads/${DEFAULT_BRANCH}`) && !block.split("\n").includes(`worktree ${ctx.root}`));
          if (options.isolate || busy || server || mainElsewhere) {
            checkout = join(ctx.root, ".worktrees", `session-${keyOf(id).slice(0, 12)}`);
            safePath(ctx.root, checkout);
            if (existsSync(checkout)) throw new Error("inspection-worktree-already-exists");
            if (git(ctx.root, ["worktree", "add", "--detach", checkout, base]).status !== 0) throw new Error("inspection-worktree-failed");
            inspection = { path: checkout, parent: ctx.root, head: value({ ...ctx, root: checkout }, ["rev-parse", "HEAD"]) };
            decision = { code: "isolated", reason: "The original checkout is in use or explicitly preserved.", branch: "", head: inspection.head, remote };
          } else if (observed.branch !== DEFAULT_BRANCH && !ancestor(ctx, "HEAD", base)) decision = outcome("preserved-branch", "This branch contains work absent from the default branch.");
          else if (value(ctx, ["rev-parse", "--verify", `refs/heads/${DEFAULT_BRANCH}`]) && !ancestor(ctx, `refs/heads/${DEFAULT_BRANCH}`, base)) decision = outcome("preserved-main-ahead", "Local default branch is ahead of or diverged from upstream.");
          else {
            const hasLocal = value(ctx, ["rev-parse", "--verify", `refs/heads/${DEFAULT_BRANCH}`]);
            const switched = git(ctx.root, hasLocal ? ["switch", DEFAULT_BRANCH] : ["switch", "-c", DEFAULT_BRANCH, "--track", `${remote}/${DEFAULT_BRANCH}`]);
            if (switched.status !== 0) throw new Error("default-switch-failed");
            const pulled = git(ctx.root, ["-c", "pull.rebase=false", "pull", "--ff-only", remote, DEFAULT_BRANCH]);
            decision = { code: pulled.status === 0 ? "synced" : "unverified-pull-failed", reason: pulled.status === 0 ? "Default branch refreshed with fast-forward only." : "Pull failed; checkout was preserved at the last safe commit.", ...current(ctx), remote };
          }
        }
      }
    }
    session = await update(ctx, (state) => {
      const item = state.sessions[keyOf(id)];
      item.initialized = true;
      item.needsBegin = false;
      item.checkout = checkout;
      if (inspection) item.inspection = inspection;
      if (options.ownerPid) {
        // Caller must supply a real owner PID, not the short-lived CLI process.
        item.owner = options.ownerIdentity;
      }
      item.git = decision;
      return item;
    });
    return { version: 1, code: decision.code, session: id, turn: session.turn, checkout, git: decision };
  }, 65000);
}

export async function removeInspection(ctx, id) {
  return lock(ctx, "git", async () => {
    const state = load(ctx);
    const session = state.sessions[keyOf(id)];
    const inspection = session?.inspection;
    if (!inspection) return;
    if (inspection.path !== join(inspection.parent, ".worktrees", `session-${keyOf(id).slice(0, 12)}`) || session.checkout !== inspection.path) throw new Error("invalid-inspection-worktree-record");
    if (Object.values(state.sessions).some((item) => item.active && item.checkout === inspection.path) || Object.values(state.resources).some((item) => item.checkout === inspection.path)) return;
    if (!existsSync(inspection.path)) return;
    const at = { ...ctx, root: inspection.path };
    if (value(at, ["symbolic-ref", "-q", "HEAD"]) || value(at, ["rev-parse", "HEAD"]) !== inspection.head) return;
    const status = git(inspection.path, ["status", "--porcelain=v1", "--untracked-files=all"], 3000);
    if (status.status !== 0 || status.stdout) return;
    // No --force: Git remains the final arbiter of disposable worktree removal.
    if (git(ctx.root === inspection.path ? ctx.anchor : ctx.root, ["worktree", "remove", inspection.path]).status === 0) {
      await update(ctx, (next) => {
        const item = next.sessions[keyOf(id)];
        item.checkout = inspection.parent;
        delete item.inspection;
      });
    }
  });
}
