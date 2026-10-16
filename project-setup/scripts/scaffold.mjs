#!/usr/bin/env node
// Renders ../templates into a target project from an answers file.
//
//   node scaffold.mjs --answers <answers.json> [--target <dir>] [--force] [--dry-run] [--sync]
//
// Template syntax (deliberately tiny, no dependencies):
//   {{VAR}}                         value from answers.vars (UPPER_SNAKE only, so
//                                   GitHub's `${{ github.x }}` passes through untouched)
//   {{#if FLAG}}…{{else}}…{{/if}}   answers.flags[FLAG] === true
//   {{#unless FLAG}}…{{/unless}}    the inverse
//   {{#each APPS}}…{{/each}}        once per answers.apps entry, with its keys as vars
//   <!-- FILL: … -->                left in place for the agent to write by hand
//
// A path segment `__APP_DIR__` renders once per app. Existing files are never
// overwritten without --force; skipped paths are reported so they can be merged.
//
// Every write records sha256(rendered content) in docs/archive/project-setup.lock.json. --sync
// uses it to bring a set-up project up to date with the current templates:
//   file missing                       → created
//   file unchanged since it was written → updated to the new render
//   template unchanged since then       → left alone (the project's edits win)
//   both changed, or no lock entry      → new render written to .project-setup/sync/<path> to merge

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(skillDir, "templates");
const manifest = JSON.parse(readFileSync(join(templatesDir, "manifest.json"), "utf8"));

function parseArgs(argv) {
  const args = {
    target: process.cwd(),
    force: false,
    dryRun: false,
    sync: false,
    answers: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--answers") {
      args.answers = argv[++index];
    } else if (arg === "--target") {
      args.target = argv[++index];
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--sync") {
      args.sync = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.answers) {
    throw new Error("usage: scaffold.mjs --answers <file> [--target <dir>] [--force] [--dry-run] [--sync]");
  }
  if (args.sync && args.force) {
    throw new Error("--sync and --force are exclusive: --sync never overwrites local edits");
  }
  return args;
}

function loadAnswers(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const vars = raw.vars ?? {};
  const flags = raw.flags ?? {};
  const apps = Array.isArray(raw.apps) ? raw.apps : [];
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value !== "string") {
      throw new Error(`vars.${key} must be a string`);
    }
  }
  for (const [key, value] of Object.entries(flags)) {
    if (typeof value !== "boolean") {
      throw new Error(`flags.${key} must be a boolean`);
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    const unsafe = UNSAFE_VALUE_CHARACTERS.find((character) => value.includes(character));
    if (unsafe && (key.startsWith("CMD_") || STRUCTURED_VARS.has(key))) {
      throw new Error(
        `vars.${key} contains ${JSON.stringify(unsafe)}; it is written into JSON and YAML. Wrap the command in a package script and use that instead.`,
      );
    }
  }
  for (const app of apps) {
    const dir = app.APP_DIR;
    const segments = typeof dir === "string" ? dir.split("/") : [];
    const unsafe = segments.some((segment) => segment === "" || segment === "." || segment === "..");
    if (typeof dir !== "string" || dir.startsWith("/") || unsafe) {
      throw new Error(`apps[].APP_DIR must be a relative sub-directory like "apps/web" (got ${JSON.stringify(dir)})`);
    }
  }
  return { vars, flags, apps };
}

// Values rendered into .claude/settings.json, workflow YAML, and JS string literals. The
// templates quote them, so only characters that break a double-quoted string are refused.
// AUTH_PACKAGE_PATTERNS is deliberately absent: its value is YAML list content with quotes.
const STRUCTURED_VARS = new Set(["RUNTIME", "DEFAULT_BRANCH"]);
const UNSAFE_VALUE_CHARACTERS = ['"', "\\", "\n", "\r"];
const LEFTOVER_BLOCK_TAG = /\{\{(?:[#/](?:if|unless|each)\b[^}]*|else)\}\}/;

const OWN_LINE_TAG =
  /^[ \t]*(\{\{(?:#if [!A-Z0-9_]+|#unless [A-Z0-9_]+|#each [A-Z0-9_]+|\/if|\/unless|\/each|else)\}\})[ \t]*\r?\n/gm;
const EACH_BLOCK = /\{\{#each ([A-Z0-9_]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
const INNERMOST_CONDITIONAL = /\{\{#(if|unless) ([A-Z0-9_]+)\}\}((?:(?!\{\{#(?:if|unless) )[\s\S])*?)\{\{\/\1\}\}/;
const VARIABLE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

function render(text, context, missing) {
  let output = text.replace(OWN_LINE_TAG, "$1");

  output = output.replace(EACH_BLOCK, (_, listName, body) => {
    if (listName !== "APPS") {
      missing.add(`#each ${listName}`);
      return "";
    }
    return context.apps
      .map((app) => render(body, { ...context, vars: { ...context.vars, ...appVars(app) } }, missing))
      .join("");
  });

  for (;;) {
    const match = INNERMOST_CONDITIONAL.exec(output);
    if (!match) {
      break;
    }
    const [whole, kind, flag, body] = match;
    const [whenTrue, whenFalse = ""] = body.split("{{else}}");
    const enabled = context.flags[flag] === true;
    const keep = (kind === "if") === enabled ? whenTrue : whenFalse;
    output = output.slice(0, match.index) + keep + output.slice(match.index + whole.length);
  }

  return output.replace(VARIABLE, (whole, name) => {
    const value = context.vars[name];
    if (value === undefined) {
      missing.add(name);
      return whole;
    }
    return value;
  });
}

function flagHolds(expression, flags) {
  if (expression.startsWith("!")) {
    return flags[expression.slice(1)] !== true;
  }
  return flags[expression] === true;
}

function included(relPath, flags) {
  if (relPath.startsWith("lean/")) return flags.LEAN === true;
  if (flags.LEAN === true && relPath === ".fallowrc.json") return false;
  if (
    flags.LEAN === true &&
    relPath.endsWith(".md") &&
    ![
      "CLAUDE.md",
      ".agents/skills/remember/SKILL.md",
      ".agents/skills/sweep/SKILL.md",
      "docs/session-lifecycle.md",
      ".github/pull_request_template.md",
      "docs/archive/product-brief.md",
    ].includes(relPath) &&
    !relPath.startsWith(".agents/skills/design-taste/")
  )
    return false;
  return manifest.when.every(
    (rule) => !(relPath === rule.path || relPath.startsWith(`${rule.path}/`)) || flagHolds(rule.flag, flags),
  );
}

function outputPath(relPath) {
  relPath = relPath.replace(/^lean\//, "");
  const name = basename(relPath);
  const renamed = manifest.rename[name];
  return renamed ? join(dirname(relPath), renamed) : relPath;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

// APP_ROOT_REL lets a per-app file link back to the repository root ("apps/web" → "../../").
function appVars(app) {
  const depth = app.APP_DIR.split("/").filter((segment) => segment.length > 0).length;
  return { ...app, APP_ROOT_REL: "../".repeat(depth) };
}

function isExecutable(relPath) {
  return manifest.executable.some((prefix) => relPath.startsWith(prefix));
}

function linkClaudeSkills(target, dryRun, report) {
  const skillsDir = join(target, ".agents", "skills");
  if (!existsSync(skillsDir)) {
    return;
  }
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const link = join(target, ".claude", "skills", entry.name);
    const exists = existsSync(link) || lstatSafe(link);
    if (exists) {
      continue;
    }
    if (!dryRun) {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join("..", "..", ".agents", "skills", entry.name), link);
    }
    report.linked.push(relative(target, link));
  }
}

// The catalog is generated by the project's own script. An existing index (e.g. a hand-written
// one in an adopted repo) is left alone and reported instead.
function generateSkillsIndex(target, report) {
  const script = join(target, "scripts", "skills", "index.mjs");
  const index = join(target, ".agents", "skills-index.md");
  if (!existsSync(script)) {
    return;
  }
  if (existsSync(index)) {
    report.skipped.push(`${relative(target, index)} (regenerate with scripts/skills/index.mjs)`);
    return;
  }
  const result = spawnSync(process.execPath, [script, "--root", target], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`skills index generation failed: ${(result.stderr || result.stdout).trim()}`);
  }
  report.created.push(relative(target, index));
}

const LOCK_PATH = join("docs", "archive", "project-setup.lock.json");
const SYNC_DIR = join(".project-setup", "sync");

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Lock = { "$meta": { generator, templatesHash }, "<path>": sha256(rendered), … }. $meta records which
// template set wrote the files (no timestamps, so renders stay reproducible).
function readLock(target) {
  const path = join(target, LOCK_PATH);
  const { $meta, ...files } = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  lockMeta = $meta;
  return files;
}
let lockMeta;

function templatesHash() {
  const parts = walk(templatesDir)
    .map((file) => relative(templatesDir, file).split(sep).join("/"))
    .sort()
    .map((rel) => `${rel}\0${sha256(readFileSync(join(templatesDir, rel), "utf8"))}`);
  return sha256(parts.join("\n"));
}

// Which of the sync outcomes in the header applies to an existing file.
function syncAction(current, rendered, locked) {
  if (current === rendered) {
    return "same";
  }
  if (locked === sha256(current)) {
    return "update";
  }
  if (locked === sha256(rendered)) {
    return "keep";
  }
  return "merge";
}

function lstatSafe(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Refuse output links before any write, including links in ancestor directories.
// The explicitly selected target itself may be a symlink; paths below it may not.
function checkOutputPath(target, path) {
  for (let probe = path; probe !== target; probe = dirname(probe)) {
    if (probe === dirname(probe)) throw new Error(`output escapes target: ${path}`);
    let stat;
    try {
      stat = lstatSync(probe);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing symlinked output: ${probe}`);
    if (stat.isFile() && stat.nlink > 1) throw new Error(`refusing hardlinked output: ${probe}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolve(args.target);
  const answers = loadAnswers(resolve(args.answers));
  const context = { vars: answers.vars, flags: answers.flags, apps: answers.apps };
  const report = { created: [], updated: [], merge: [], skipped: [], excluded: 0, linked: [] };
  checkOutputPath(target, join(target, LOCK_PATH));
  const lock = readLock(target);
  const missing = new Set();
  const pending = [];

  // Render everything in memory first: a missing variable or unbalanced block writes nothing,
  // so the fix never needs --force over half-rendered files.
  for (const file of walk(templatesDir)) {
    const relPath = relative(templatesDir, file).split(sep).join("/");
    if (relPath === "manifest.json" || !included(relPath, answers.flags)) {
      report.excluded += 1;
      continue;
    }
    const source = readFileSync(file, "utf8");
    const perApp = relPath.includes("__APP_DIR__");
    const targets = perApp
      ? answers.apps.map((app) => ({
          path: relPath.replaceAll("__APP_DIR__", app.APP_DIR),
          context: { ...context, vars: { ...context.vars, ...appVars(app) } },
        }))
      : [{ path: relPath, context }];

    for (const item of targets) {
      const destination = join(target, outputPath(item.path));
      const shown = relative(target, destination).split(sep).join("/");
      const exists = existsSync(destination);
      if (exists && !args.force && !args.sync) {
        report.skipped.push(shown);
        continue;
      }
      const content = render(source, item.context, missing);
      const leftover = LEFTOVER_BLOCK_TAG.exec(content);
      if (leftover) {
        missing.add(`unbalanced ${leftover[0]} in ${relPath}`);
      }
      const executable = isExecutable(item.path);
      if (!exists || args.force) {
        pending.push({ destination, content, executable, lockKey: shown });
        report.created.push(shown);
        continue;
      }
      const action = syncAction(readFileSync(destination, "utf8"), content, lock[shown]);
      if (action === "same") {
        lock[shown] = sha256(content);
      } else if (action === "update") {
        pending.push({ destination, content, executable, lockKey: shown });
        report.updated.push(shown);
      } else if (action === "merge") {
        // lock the new render so the next sync sees "template unchanged" and the merged file wins
        lock[shown] = sha256(content);
        pending.push({ destination: join(target, SYNC_DIR, shown), content, executable });
        report.merge.push(shown);
      }
    }
  }

  if (missing.size > 0) {
    console.error(`unresolved template variables or blocks: ${[...missing].join(", ")}`);
    console.error("Nothing was written. Fix the answers file (or template) and rerun.");
    process.exit(1);
  }

  for (const item of pending) checkOutputPath(target, item.destination);
  checkOutputPath(target, join(target, ".agents", "skills-index.md"));
  if (answers.flags.CLAUDE_CODE === true && answers.flags.CLAUDE_SKILL_LINKS !== false)
    checkOutputPath(target, join(target, ".claude", "skills"));

  if (!args.dryRun) {
    for (const item of pending) {
      mkdirSync(dirname(item.destination), { recursive: true });
      writeFileSync(item.destination, item.content);
      if (item.executable) {
        chmodSync(item.destination, 0o755);
      }
      if (item.lockKey) {
        lock[item.lockKey] = sha256(item.content);
      }
    }
    const sorted = {
      $meta: { generator: "project-setup", templatesHash: templatesHash() },
      ...Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b))),
    };
    mkdirSync(dirname(join(target, LOCK_PATH)), { recursive: true });
    writeFileSync(join(target, LOCK_PATH), `${JSON.stringify(sorted, null, 2)}\n`);
  }

  if (answers.flags.CLAUDE_CODE === true && answers.flags.CLAUDE_SKILL_LINKS !== false) {
    linkClaudeSkills(target, args.dryRun, report);
  }

  if (!args.dryRun) {
    generateSkillsIndex(target, report);
  }

  const prefix = args.dryRun ? "[dry-run] would create" : "created";
  console.log(`${prefix} ${report.created.length} files in ${target}`);
  for (const path of report.created) {
    console.log(`  + ${path}`);
  }
  if (report.updated.length > 0) {
    console.log(`updated ${report.updated.length} files untouched since they were rendered:`);
    for (const path of report.updated) {
      console.log(`  ~ ${path}`);
    }
  }
  if (report.merge.length > 0) {
    console.log(
      `\nmerge ${report.merge.length} files changed both here and in the templates — diff each against ${SYNC_DIR}/<path>, merge, then delete .project-setup/:`,
    );
    for (const path of report.merge) {
      console.log(`  ! ${path}`);
    }
  }
  if (report.linked.length > 0) {
    console.log(`linked ${report.linked.length} skills into .claude/skills`);
  }
  if (report.skipped.length > 0) {
    console.log(`\nskipped ${report.skipped.length} existing files (merge by hand or rerun with --force):`);
    for (const path of report.skipped) {
      console.log(`  = ${path}`);
    }
  }
  console.log(`excluded ${report.excluded} templates by flags`);
  if (args.sync) {
    const now = templatesHash();
    console.log(
      lockMeta?.templatesHash === now
        ? "templates: unchanged since the last render"
        : `templates: changed since the last render (${lockMeta?.templatesHash?.slice(0, 12) ?? "no record — rendered by an older version"} → ${now.slice(0, 12)})`,
    );
  }
  console.log(
    args.sync
      ? "\nNext: merge the listed files, delete .project-setup/, then run scripts/checks/docs-check.mjs."
      : "\nNext: replace every <!-- FILL: … --> marker, then run scripts/checks/docs-check.mjs.",
  );
}

try {
  main();
} catch (error) {
  console.error(`[scaffold] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
