#!/usr/bin/env node
// Reports whether a branch is actually protected on GitHub. Read-only (two `gh api` GETs).
// A workflow file does not enforce merging; this reports the effective state, or says it cannot tell.
//
//   protection.mjs [--repo owner/name] [--branch main] [--checks checks,do-not-merge] [--require]
//
// States: PROTECTED (required checks, strict, no known bypass) · INCOMPLETE · UNPROTECTED · UNKNOWN (no access/gh).
// --require exits 1 unless PROTECTED. Without it the exit code is 0 so a report never breaks setup.

import { existsSync } from "node:fs";
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
const required = (opt("--checks") ?? `checks,do-not-merge${existsSync(".agents/policy.json") ? ",trusted-gates" : ""}`)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function check() {
  if (!repo) return { state: "UNKNOWN", why: "repository not identified (is gh installed and logged in?)" };
  const classic = gh(`repos/${repo}/branches/${encodeURIComponent(branch)}/protection`);
  const contexts = new Set();
  let exists = false,
    strict = false,
    bypass = false,
    unreadable = false;
  if (classic.status === 0) {
    try {
      const p = JSON.parse(classic.stdout);
      exists = true;
      for (const c of p.required_status_checks?.contexts ?? []) contexts.add(c);
      for (const c of p.required_status_checks?.checks ?? []) contexts.add(c.context);
      strict = p.required_status_checks?.strict === true;
      bypass = p.enforce_admins?.enabled !== true;
    } catch {
      unreadable = true;
    }
  }
  const rules = gh(`repos/${repo}/rules/branches/${encodeURIComponent(branch)}`);
  if (rules.status === 0) {
    try {
      const list = JSON.parse(rules.stdout);
      if (!Array.isArray(list)) throw new Error("invalid rules response");
      exists ||= list.length > 0;
      for (const rule of list.filter((r) => r.type === "required_status_checks")) {
        for (const c of rule.parameters?.required_status_checks ?? []) contexts.add(c.context);
        strict ||= rule.parameters?.strict_required_status_checks_policy === true;
      }
      for (const id of new Set(list.map((r) => r.ruleset_id).filter(Boolean))) {
        const r = gh(`repos/${repo}/rulesets/${id}`);
        if (r.status !== 0) {
          unreadable = true;
          continue;
        }
        bypass ||= (JSON.parse(r.stdout).bypass_actors ?? []).length > 0;
      }
      if (!exists && /not protected|not found/i.test(classic.stderr))
        return { state: "UNPROTECTED", why: "no branch protection and no ruleset rules" };
    } catch {
      unreadable = true;
    }
  } else if (!exists) unreadable = true;
  if (exists) {
    const missing = required.filter((c) => !contexts.has(c));
    if (missing.length || !strict || bypass || unreadable)
      return {
        state: "INCOMPLETE",
        why: [
          missing.length ? `missing required checks: ${missing.join(", ")}` : "",
          !strict ? "checks need an up-to-date branch" : "",
          bypass ? "bypass actors/admin bypass allowed" : "",
          unreadable ? "could not verify all protection settings" : "",
        ]
          .filter(Boolean)
          .join("; "),
      };
    return {
      state: "PROTECTED",
      why: `required checks enforced: ${required.join(", ")}; no configured bypass observed`,
    };
  }

  return {
    state: "UNKNOWN",
    why: `could not read protection (${classic.stderr.trim().split("\n")[0] || "no output"})`,
  };
}

const { state, why } = check();
console.log(`${repo ?? "?"}@${branch}: ${state} — ${why}`);
if (state !== "PROTECTED") {
  console.log(
    "Merge gating needs owner-configured branch protection or a ruleset requiring the CI checks; the workflow files alone do not enforce it.",
  );
}
process.exit(args.includes("--require") && state !== "PROTECTED" ? 1 : 0);
