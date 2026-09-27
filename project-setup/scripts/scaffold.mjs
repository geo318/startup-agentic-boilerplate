#!/usr/bin/env node
// Renders ../templates into a target project from an answers file.
//
//   node scaffold.mjs --answers <answers.json> [--target <dir>] [--force] [--dry-run]
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
  const args = { target: process.cwd(), force: false, dryRun: false, answers: undefined };
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
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.answers) {
    throw new Error("usage: scaffold.mjs --answers <file> [--target <dir>] [--force] [--dry-run]");
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
    const unsafe = segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    );
    if (typeof dir !== "string" || dir.startsWith("/") || unsafe) {
      throw new Error(
        `apps[].APP_DIR must be a relative sub-directory like "apps/web" (got ${JSON.stringify(dir)})`,
      );
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
const INNERMOST_CONDITIONAL =
  /\{\{#(if|unless) ([A-Z0-9_]+)\}\}((?:(?!\{\{#(?:if|unless) )[\s\S])*?)\{\{\/\1\}\}/;
const VARIABLE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

function render(text, context, missing) {
  let output = text.replace(OWN_LINE_TAG, "$1");

  output = output.replace(EACH_BLOCK, (_, listName, body) => {
    if (listName !== "APPS") {
      missing.add(`#each ${listName}`);
      return "";
    }
    return context.apps
      .map((app) =>
        render(body, { ...context, vars: { ...context.vars, ...appVars(app) } }, missing),
      )
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
  return manifest.when.every(
    (rule) =>
      !(relPath === rule.path || relPath.startsWith(`${rule.path}/`)) ||
      flagHolds(rule.flag, flags),
  );
}

function outputPath(relPath) {
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

function lstatSafe(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolve(args.target);
  const answers = loadAnswers(resolve(args.answers));
  const context = { vars: answers.vars, flags: answers.flags, apps: answers.apps };
  const report = { created: [], skipped: [], excluded: 0, linked: [] };
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
      const shown = relative(target, destination);
      if (existsSync(destination) && !args.force) {
        report.skipped.push(shown);
        continue;
      }
      const content = render(source, item.context, missing);
      const leftover = LEFTOVER_BLOCK_TAG.exec(content);
      if (leftover) {
        missing.add(`unbalanced ${leftover[0]} in ${relPath}`);
      }
      pending.push({ destination, content, executable: isExecutable(item.path) });
      report.created.push(shown);
    }
  }

  if (missing.size > 0) {
    console.error(`unresolved template variables or blocks: ${[...missing].join(", ")}`);
    console.error("Nothing was written. Fix the answers file (or template) and rerun.");
    process.exit(1);
  }

  if (!args.dryRun) {
    for (const item of pending) {
      mkdirSync(dirname(item.destination), { recursive: true });
      writeFileSync(item.destination, item.content);
      if (item.executable) {
        chmodSync(item.destination, 0o755);
      }
    }
  }

  if (answers.flags.CLAUDE_CODE === true && answers.flags.CLAUDE_SKILL_LINKS !== false) {
    linkClaudeSkills(target, args.dryRun, report);
  }

  const prefix = args.dryRun ? "[dry-run] would create" : "created";
  console.log(`${prefix} ${report.created.length} files in ${target}`);
  for (const path of report.created) {
    console.log(`  + ${path}`);
  }
  if (report.linked.length > 0) {
    console.log(`linked ${report.linked.length} skills into .claude/skills`);
  }
  if (report.skipped.length > 0) {
    console.log(
      `\nskipped ${report.skipped.length} existing files (merge by hand or rerun with --force):`,
    );
    for (const path of report.skipped) {
      console.log(`  = ${path}`);
    }
  }
  console.log(`excluded ${report.excluded} templates by flags`);
  console.log(
    "\nNext: replace every <!-- FILL: … --> marker, then run scripts/checks/docs-check.mjs.",
  );
}

try {
  main();
} catch (error) {
  console.error(`[scaffold] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
