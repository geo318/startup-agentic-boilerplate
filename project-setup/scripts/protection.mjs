#!/usr/bin/env node
// Reports whether a branch is actually protected on GitHub. Read-only (two `gh api` GETs).
// A workflow file does not enforce merging; this reports the effective state, or says it cannot tell.
//
//   protection.mjs [--repo owner/name] [--branch main] [--require]
//
// States: PROTECTED (classic protection or a ruleset applies) · UNPROTECTED · UNKNOWN (no access/gh).
// --require exits 1 unless PROTECTED. Without it the exit code is 0 so a report never breaks setup.

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const gh = (path) => spawnSync("gh", ["api", path], { encoding: "utf8" });

let repo = opt("--repo");
if (!repo) {
  const r = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { encoding: "utf8" });
  repo = r.status === 0 ? r.stdout.trim() : undefined;
}
const branch = opt("--branch") ?? "main";

function check() {
  if (!repo) return { state: "UNKNOWN", why: "repository not identified (is gh installed and logged in?)" };
  const classic = gh(`repos/${repo}/branches/${branch}/protection`);
  if (classic.status === 0) return { state: "PROTECTED", why: "classic branch protection is enabled" };
  const rules = gh(`repos/${repo}/rules/branches/${branch}`);
  if (rules.status === 0) {
    try {
      const list = JSON.parse(rules.stdout || "[]");
      if (list.length > 0) return { state: "PROTECTED", why: `${list.length} ruleset rule(s) apply` };
      // no ruleset rules; classic said "not protected" or was unreadable
      if (/not protected|not found/i.test(classic.stderr)) return { state: "UNPROTECTED", why: "no branch protection and no ruleset rules" };
    } catch {}
  }
  return { state: "UNKNOWN", why: `could not read protection (${classic.stderr.trim().split("\n")[0] || "no output"})` };
}

const { state, why } = check();
console.log(`${repo ?? "?"}@${branch}: ${state} — ${why}`);
if (state !== "PROTECTED") {
  console.log("Merge gating needs owner-configured branch protection or a ruleset requiring the CI checks; the workflow files alone do not enforce it.");
}
process.exit(args.includes("--require") && state !== "PROTECTED" ? 1 : 0);
