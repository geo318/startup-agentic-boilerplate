---
name: sweep
description: Clean up leftover project processes, stale local caches, and unused Git worktrees. Use when asked to sweep or reclaim local disk space, or when diagnosing abandoned development resources.
---

# Sweep

Inspect the current project, identify disposable resources, then clean up verified candidates.
A sweep request authorizes the safe cleanup below; report uncertain candidates without deleting
or stopping them. This skill uses existing OS, Git, and project tools directly.

## Inspect first

- Establish the repository root, current checkout, and `git worktree list --porcelain`.
- Inspect project scripts and cache configuration, candidate sizes and modification times, and
  running processes with their command, working directory, and owner (`ps` and `lsof` where available).
- Age alone does not prove abandonment. Preserve resources used by another task, user, build,
  dev server, or watcher. If activity or ownership cannot be verified, skip the candidate.

## Leftover processes

Stop only processes attributable to this task that are no longer needed, or specific abandoned
project processes the user has authorized stopping. Recheck PID identity and working directory
immediately before sending SIGTERM; verify exit. Never kill by port or process name, use broad
`pkill`, or assume every process in this repository belongs to this task. Report survivors;
force-killing requires specific authorization.

## Stale caches

Identify reproducible, project-local tool caches from configuration and the tool's documented
behavior (for example `.next/cache`, `.turbo`, `.vite`, or `node_modules/.cache`). Clean caches
that are unused and obsolete, implicated in stale behavior, or included in the requested disk
cleanup. Prefer a tool's scoped cache-clean command after checking what it deletes.

Before deletion, verify the exact path stays inside the intended checkout, is not a symlink or
reached through one, contains no tracked files, and has no active users. Use explicit paths;
never broad globs, `git clean -fdx`, or whole output-directory deletion as a cache shortcut.
Gitignored does not mean disposable. Preserve dependencies, secrets, databases, uploads,
volumes, logs needed for diagnosis, and user output. Shared/global package caches and Docker
pruning require a separate explicit request. Report that cleared caches rebuild on next use.

## Stale worktrees

1. Inspect `git worktree list --porcelain`; use `git worktree prune --dry-run --verbose` to
   identify obsolete administrative records. Run ordinary `git worktree prune --verbose` only
   for verified abandoned records; preserve locked worktrees and temporarily unavailable mounts.
   Do not override Git's expiration defaults.
2. For an existing worktree, establish that it belongs to this task or is confirmed abandoned.
   Never remove the primary checkout, current checkout, locked worktrees, another task's worktree,
   or a worktree with running processes or an ongoing Git operation.
3. Check staged, unstaged, and untracked files, submodules, and ignored files. Preserve any local
   work or non-reproducible ignored data. Fetch the configured remote before evaluating branch
   status; if freshness cannot be established, skip removal.
4. Verify HEAD is included in the current remote default branch with `git merge-base --is-ancestor`.
   An old directory, missing upstream branch, or closed PR alone is insufficient. Preserve
   unmerged/unpushed commits. Squash merges need separate verification; skip ambiguous cases.
   Apply the same reachability check to detached worktrees.
5. Recheck status and activity, then use `git worktree remove <exact-path>` without `--force`.
   Leave local branches intact unless branch deletion was also requested. Report failed removals;
   never bypass Git's refusal with recursive deletion.

## Report

List what was removed/stopped, space reclaimed when measured, and what remains with reasons.
Do not claim a complete cleanup when checks were unavailable or candidates were skipped.
