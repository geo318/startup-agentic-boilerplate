#!/usr/bin/env node
// Read-only audit of what an agent session loads up front and what it actually uses, so token
// savings are suggested from numbers. Run after setup/adoption.
//
//   node token-audit.mjs [--target <dir>]
//
// Sizes are bytes / 4, an estimate. Usage is counted from this project's Claude Code transcripts.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const argIdx = process.argv.indexOf("--target");
const root = resolve(argIdx > 0 ? process.argv[argIdx + 1] : process.cwd());
const home = homedir();
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

// Always-loaded instruction files.
const instructionFiles = [
  join(home, ".claude/CLAUDE.md"),
  join(home, ".claude/RTK.md"),
  join(root, "CLAUDE.md"),
  join(root, "AGENTS.md"),
].filter(existsSync).map((path) => ({ path, tokens: tokens(read(path)) }));

// Skills: only the frontmatter description is always loaded.
const skillRoots = [join(root, ".claude/skills"), join(home, ".claude/skills")];
const skills = skillRoots.flatMap((base) =>
  dirs(base).filter((name) => existsSync(join(base, name, "SKILL.md"))).map((name) => {
    const text = read(join(base, name, "SKILL.md"));
    const description = /^description:\s*(.*)$/m.exec(text)?.[1] ?? "";
    return { name, tokens: tokens(description) + 20 };
  }),
);

// MCP servers: each one's tool schemas load every session (unless tool search defers them).
const userConfig = json(join(home, ".claude.json"));
const mcpServers = [
  ...Object.keys(json(join(root, ".mcp.json")).mcpServers ?? {}),
  ...Object.keys(userConfig.mcpServers ?? {}),
  ...Object.keys(userConfig.projects?.[root]?.mcpServers ?? {}),
];

const settings = json(join(home, ".claude/settings.json"));
const enabledPlugins = Object.entries(settings.enabledPlugins ?? {}).filter(([, on]) => on).map(([name]) => name);

// Usage from the project's transcripts (newest 40).
const transcripts = join(home, ".claude/projects", root.replace(/[/.]/g, "-"));
const used = { mcp: {}, skills: {}, sessions: 0 };
const files = dirs(transcripts)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => ({ f, t: statSync(join(transcripts, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
  .slice(0, 40);
for (const { f } of files) {
  used.sessions++;
  const text = read(join(transcripts, f));
  for (const [, server] of text.matchAll(/"name":"mcp__([^"_]+(?:_[^"_]+)*?)__/g)) used.mcp[server] = (used.mcp[server] ?? 0) + 1;
  for (const [, name] of text.matchAll(/"name":"Skill","input":\{"skill":"([^"]+)"/g)) used.skills[name] = (used.skills[name] ?? 0) + 1;
}

const unusedSkills = skills.filter((s) => !used.skills[s.name]).sort((a, b) => b.tokens - a.tokens);
console.log(JSON.stringify({
  instructionFiles,
  skills: { count: skills.length, tokens: skills.reduce((n, s) => n + s.tokens, 0), unused: unusedSkills.map((s) => s.name) },
  mcpServers: { configured: mcpServers, usedCalls: used.mcp, unused: mcpServers.filter((s) => !Object.keys(used.mcp).some((u) => u.includes(s))) },
  enabledPlugins,
  sessionsScanned: used.sessions,
}, null, 2));
