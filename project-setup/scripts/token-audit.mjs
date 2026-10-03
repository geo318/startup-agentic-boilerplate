#!/usr/bin/env node
// Read-only audit of what an agent session loads up front and what it actually uses, so token
// savings are suggested from numbers. Run after setup/adoption.
//
//   node token-audit.mjs [--target <dir>]
//
// Sizes are characters / 4, an estimate, not tokenizer measurements. Usage is counted from this project's Claude Code transcripts.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "../templates/scripts/skills/index.mjs";

const argIdx = process.argv.indexOf("--target");
const root = resolve(argIdx > 0 ? process.argv[argIdx + 1] : process.cwd());
const home = homedir();
const harnessArg = process.argv.indexOf("--harness");
const harness = harnessArg >= 0 ? process.argv[harnessArg + 1] : "all";
if (!["all", "codex", "claude"].includes(harness)) throw new Error("--harness must be all, codex, or claude");
const tokens = (text) => Math.round(text.length / 4);
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const json = (path) => {
  try {
    return JSON.parse(read(path) || "{}");
  } catch {
    return {};
  }
};
const dirs = (path) => (existsSync(path) ? readdirSync(path) : []);

// Inventory plus explicit Markdown imports; harness/plugin loading can add more context.
const instructionFiles = [];
const seenInstructions = new Set();
function instruction(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return;
  const real = realpathSync(path);
  if (seenInstructions.has(real)) return;
  seenInstructions.add(real);
  const body = read(real);
  instructionFiles.push({ path: real, tokens: tokens(body) });
  for (const [, ref] of body.matchAll(/^@([^\s]+\.md)\s*$/gm))
    instruction(ref.startsWith("~/") ? join(home, ref.slice(2)) : resolve(dirname(real), ref));
}
for (const path of [
  ...(harness !== "codex" ? [join(home, ".claude/CLAUDE.md"), join(root, "CLAUDE.md")] : []),
  ...(harness !== "claude" ? [join(home, ".codex/AGENTS.md"), join(home, ".codex/AGENTS.override.md")] : []),
  join(root, "AGENTS.md"),
  join(root, "AGENTS.override.md"),
])
  instruction(path);

// Skills: only the frontmatter description is always loaded.
const skillRoots = [
  join(root, ".agents/skills"),
  join(home, ".agents/skills"),
  ...(harness !== "codex" ? [join(root, ".claude/skills"), join(home, ".claude/skills")] : []),
  ...(harness !== "claude"
    ? [join(root, ".codex/skills"), join(home, ".codex/skills"), join(home, ".codex/skills/.system")]
    : []),
];
const seenSkills = new Set();
const skills = skillRoots.flatMap((base) =>
  dirs(base)
    .filter((name) => {
      const path = join(base, name, "SKILL.md");
      if (!existsSync(path)) return false;
      const real = realpathSync(path);
      if (seenSkills.has(real)) return false;
      seenSkills.add(real);
      return true;
    })
    .map((name) => {
      const text = read(join(base, name, "SKILL.md"));
      const description = parseFrontmatter(text.split(/\r?\n/))?.description ?? "";
      return { name, tokens: tokens(description) + 20 };
    }),
);

// Configuration inventory, not effective session state. Keep each harness's sources separate.
const claudeConfig = harness !== "codex" ? json(join(home, ".claude.json")) : {};
const claudeServers = harness !== "codex" ? [
  ...Object.keys(json(join(root, ".mcp.json")).mcpServers ?? {}),
  ...Object.keys(claudeConfig.mcpServers ?? {}),
  ...Object.keys(claudeConfig.projects?.[root]?.mcpServers ?? {}),
] : [];
const claudeSettings = harness !== "codex" ? {
  ...json(join(home, ".claude/settings.json")).enabledPlugins,
  ...json(join(root, ".claude/settings.json")).enabledPlugins,
} : {};
const enabledPlugins = Object.entries(claudeSettings)
  .filter(([, on]) => on)
  .map(([name]) => name);

const codexConfigFiles = harness !== "claude"
  ? [...new Set([join(home, ".codex/config.toml"), join(root, ".codex/config.toml")])].filter(existsSync)
  : [];
// Recognize standard MCP table headers only; do not pretend this is a full TOML parser.
const codexServers = codexConfigFiles.flatMap((path) =>
  [...read(path).matchAll(/^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]\s*(?:#.*)?$/gm)]
    .map(([, key]) => key.startsWith('"') ? JSON.parse(key) : key.startsWith("'") ? key.slice(1, -1) : key),
);
const mcpServers = [...new Set([...claudeServers, ...codexServers])];

// Usage from the project's transcripts (newest 40).
const transcripts = join(home, ".claude/projects", root.replace(/[/.]/g, "-"));
const used = { mcp: {}, skills: {}, sessions: 0 };
const files = (harness === "codex" ? [] : dirs(transcripts))
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => ({ f, t: statSync(join(transcripts, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(0, 40);
for (const { f } of files) {
  used.sessions++;
  const text = read(join(transcripts, f));
  for (const [, server] of text.matchAll(/"name":"mcp__([^"_]+(?:_[^"_]+)*?)__/g))
    used.mcp[server] = (used.mcp[server] ?? 0) + 1;
  for (const [, name] of text.matchAll(/"name":"Skill","input":\{"skill":"([^"]+)"/g))
    used.skills[name] = (used.skills[name] ?? 0) + 1;
}

const unusedSkills = skills.filter((s) => !used.skills[s.name]).sort((a, b) => b.tokens - a.tokens);
console.log(
  JSON.stringify(
    {
      usageSource: harness === "codex" ? "unavailable" : "claude-code-only",
      harness,
      tokenMethod: "estimated characters / 4; filesystem inventory, not measured session loading",
      limitations: [
        "Active plugin catalogs, deferred tool schemas, and ancestor instructions may add context",
        "Codex MCP inventory recognizes standard mcp_servers table headers only; inline tables, profiles, trust, and enabled state are not resolved",
        "enabledPlugins inventories Claude settings only; Codex plugin state is not inferred from Claude configuration",
        "No Claude calls does not establish non-use in other harnesses; unused lists require --harness claude",
      ],
      instructionFiles,
      skills: {
        count: skills.length,
        tokens: skills.reduce((n, s) => n + s.tokens, 0),
        unused: used.sessions && harness === "claude" ? unusedSkills.map((s) => s.name) : [],
      },
      mcpServers: {
        configured: mcpServers,
        byHarness: { claude: [...new Set(claudeServers)], codex: [...new Set(codexServers)] },
        usedCalls: used.mcp,
        unused:
          used.sessions && harness === "claude"
            ? mcpServers.filter((s) => !Object.keys(used.mcp).some((u) => u.includes(s)))
            : [],
      },
      enabledPlugins,
      codexConfigFiles,
      sessionsScanned: used.sessions,
    },
    null,
    2,
  ),
);
