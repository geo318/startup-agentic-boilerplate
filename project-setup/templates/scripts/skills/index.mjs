#!/usr/bin/env node
// Generates .agents/skills-index.md from the frontmatter of every .agents/skills/<name>/SKILL.md.
//
//   index.mjs [--root <dir>]            write the index
//   index.mjs --check [--root <dir>]    exit 1 if the committed index is stale
//
// docs-check.mjs runs the check, so adding or removing a skill without regenerating fails
// `docs:check`, the pre-push hook, and CI. Runs under both Node and Bun; no dependencies.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_PATH = ".agents/skills-index.md";
const SKILLS_DIR = ".agents/skills";
const MAX_DESCRIPTION = 170;
const REGENERATE = "{{RUNTIME}} scripts/skills/index.mjs";

function parseArgs(argv) {
  const args = { root: process.cwd(), check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      args.root = argv[++index];
    } else if (argv[index] === "--check") {
      args.check = true;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return { ...args, root: resolve(args.root) };
}

function isIndented(line) {
  return line.startsWith(" ") || line.startsWith("\t");
}

function unquote(raw) {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, raw.endsWith('"') ? -1 : undefined);
    }
  }
  if (raw.startsWith("'")) {
    return raw.slice(1, raw.endsWith("'") ? -1 : undefined).replaceAll("''", "'");
  }
  return raw;
}

// Enough YAML for skill frontmatter: plain, quoted, folded (>) and literal (|) scalars, and
// indented continuation lines. Nested structures are ignored.
export function parseFrontmatter(lines) {
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (lines[0]?.trim() !== "---" || end < 0) {
    return null;
  }
  const fields = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    const colon = line.indexOf(":");
    if (isIndented(line) || colon <= 0) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const first = line.slice(colon + 1).trim();
    const continuation = [];
    while (
      index + 1 < end &&
      (isIndented(lines[index + 1] ?? "") || lines[index + 1]?.trim() === "")
    ) {
      index += 1;
      continuation.push((lines[index] ?? "").trim());
    }
    const isBlock = first.startsWith(">") || first.startsWith("|");
    const raw = (isBlock ? continuation : [first, ...continuation]).join(" ").trim();
    fields[key] = isBlock ? raw : unquote(raw);
  }
  return fields;
}

// Skills without frontmatter still get a row: the first prose paragraph after the title.
function firstParagraph(lines) {
  const paragraph = [];
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith("#") || text.startsWith("```") || text.startsWith("---")) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (text === "") {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(text);
  }
  return paragraph.join(" ");
}

function stripMarkdownLinks(text) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("[", index);
    const close = open >= 0 ? text.indexOf("](", open) : -1;
    const end = close >= 0 ? text.indexOf(")", close) : -1;
    if (open < 0 || close < 0 || end < 0) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, open) + text.slice(open + 1, close);
    index = end + 1;
  }
  return output;
}

function tableCell(text) {
  const flat = stripMarkdownLinks(text).split(/\s+/).join(" ").trim().replaceAll("|", "\\|");
  if (flat.length <= MAX_DESCRIPTION) {
    return flat;
  }
  const cut = flat.slice(0, MAX_DESCRIPTION);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

function listSkills(root) {
  const skillsDir = join(root, SKILLS_DIR);
  if (!existsSync(skillsDir)) {
    return [];
  }
  return readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory())
    .toSorted();
}

function buildIndex(root) {
  const warnings = [];
  const rows = [];
  for (const directory of listSkills(root)) {
    const path = join(root, SKILLS_DIR, directory, "SKILL.md");
    if (!existsSync(path)) {
      warnings.push(`${SKILLS_DIR}/${directory} has no SKILL.md; skipped`);
      continue;
    }
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    const fields = parseFrontmatter(lines);
    if (!fields?.description) {
      warnings.push(
        `${SKILLS_DIR}/${directory}/SKILL.md has no frontmatter description; agents cannot auto-discover it`,
      );
    }
    if (fields?.name && fields.name !== directory) {
      warnings.push(
        `${SKILLS_DIR}/${directory}: frontmatter name '${fields.name}' differs from its folder`,
      );
    }
    const description = fields?.description || firstParagraph(lines) || "(no description)";
    rows.push(`| [${directory}](skills/${directory}/SKILL.md) | ${tableCell(description)} |`);
  }
  const body = rows.length > 0 ? rows : ["| — | No skills installed. |"];
  const content = [
    `<!-- Generated from each skill's SKILL.md by scripts/skills/index.mjs. Do not edit; run \`${REGENERATE}\`. -->`,
    "",
    "# Complete project skill catalog",
    "",
    "Use this catalog only when the curated [skill guide](README.md) does not route the task.",
    "Descriptions summarize discovery metadata; read the selected `SKILL.md` for its actual",
    "constraints, then only the references you need. Upstream examples never override root",
    "project rules.",
    "",
    "| Skill | Use when |",
    "| --- | --- |",
    ...body,
    "",
  ].join("\n");
  return { content, warnings };
}

function main() {
  const { root, check } = parseArgs(process.argv.slice(2));
  const { content, warnings } = buildIndex(root);
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  const indexFile = join(root, INDEX_PATH);
  if (check) {
    const current = existsSync(indexFile)
      ? readFileSync(indexFile, "utf8").replaceAll("\r\n", "\n")
      : null;
    if (current !== content) {
      console.error(
        `${INDEX_PATH} is ${current === null ? "missing" : "stale"}; run \`${REGENERATE}\``,
      );
      process.exit(1);
    }
    return;
  }
  mkdirSync(dirname(indexFile), { recursive: true });
  writeFileSync(indexFile, content);
  console.log(`wrote ${INDEX_PATH} (${listSkills(root).length} skills)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[skills index] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
