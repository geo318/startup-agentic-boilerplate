#!/usr/bin/env node
// Inventories a target directory so the agent reads one JSON result instead of exploring the repo:
// mode (new/adopt/upgrade/sync), a draft answers file, the tooling already in place, layout
// hints for boundary zones, and the conflicts that need a decision.
//
//   node detect.mjs [--target <dir>]
//
// Read-only. Runs under both Node and Bun; no dependencies.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "build", "coverage"]);
const LAYER_DIRS = new Set([
  "modules",
  "features",
  "domain",
  "services",
  "routes",
  "api",
  "db",
  "repositories",
  "adapters",
  "server",
]);
const FRAMEWORKS = [
  ["next", "Next.js"],
  ["expo", "Expo"],
  ["@remix-run/react", "Remix"],
  ["@sveltejs/kit", "SvelteKit"],
  ["vite", "Vite"],
  ["elysia", "Elysia"],
  ["hono", "Hono"],
  ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"],
  ["express", "Express"],
];
const UI_DEPS = ["react", "vue", "svelte", "solid-js", "expo", "next"];
const DB_DEPS = ["drizzle-orm", "@prisma/client", "prisma", "kysely", "typeorm", "mongoose", "pg"];
const AUTH_DEPS = ["better-auth", "next-auth", "@auth/core", "@clerk/nextjs", "lucia"];
const AI_DEPS = ["ai", "@anthropic-ai/sdk", "openai", "langchain", "@langchain/core"];
const JOB_DEPS = ["@trigger.dev/sdk", "bullmq", "inngest"];
const E2E_DEPS = ["@playwright/test", "cypress"];
const PACKAGE_MANAGERS = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];
const INSTALL = {
  bun: ["bun install", "bun install --frozen-lockfile", "bun run", "bunx"],
  pnpm: ["pnpm install", "pnpm install --frozen-lockfile", "pnpm", "pnpm exec"],
  yarn: ["yarn install", "yarn install --immutable", "yarn", "yarn"],
  npm: ["npm install", "npm ci", "npm run", "npx"],
};

function parseArgs(argv) {
  if (argv[0] === "--target" && argv[1]) {
    return resolve(argv[1]);
  }
  if (argv.length > 0) {
    throw new Error("usage: detect.mjs [--target <dir>]");
  }
  return process.cwd();
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function listDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function workspaceGlobs(root, pkg) {
  const fromPackage = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (Array.isArray(fromPackage)) {
    return fromPackage;
  }
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (!existsSync(pnpm)) {
    return [];
  }
  return [...readFileSync(pnpm, "utf8").matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?/gm)].map((match) => match[1]);
}

// ponytail: supports "dir/*" and exact paths, the shapes real workspace globs use; add "**" if needed.
function expandWorkspaces(root, globs) {
  const dirs = [];
  for (const glob of globs.filter((pattern) => !pattern.startsWith("!"))) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -2);
      for (const entry of listDir(join(root, parent))) {
        if (entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json"))) {
          dirs.push(`${parent}/${entry.name}`);
        }
      }
    } else if (existsSync(join(root, glob, "package.json"))) {
      dirs.push(glob);
    }
  }
  return dirs;
}

function dependencies(pkg) {
  return Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies });
}

function layerDirs(root) {
  const found = [];
  const walk = (dir, depth) => {
    for (const entry of listDir(dir)) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const full = join(dir, entry.name);
      if (LAYER_DIRS.has(entry.name)) {
        const children = listDir(full).filter((child) => child.isDirectory()).length;
        found.push({ path: relative(root, full).split(sep).join("/"), children });
      }
      if (depth < 4) {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

function detectMode(root) {
  if (existsSync(join(root, "docs", "archive", "project-setup.answers.json"))) {
    return "sync";
  }
  if (existsSync(join(root, "AGENTS.md")) || existsSync(join(root, "context"))) {
    return "upgrade";
  }
  const meaningful = listDir(root).filter((entry) => ![".git", ".claude"].includes(entry.name));
  return meaningful.length === 0 ? "new" : "adopt";
}

// Which token-saving tools are installed on this machine (see references/token-tools.md).
function tokenTools() {
  const onPath = (cmd) => spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
  const registry = join(homedir(), ".claude/plugins/installed_plugins.json");
  const plugins = existsSync(registry) ? readFileSync(registry, "utf8") : "";
  return { rtk: onPath("rtk"), headroom: onPath("headroom"), ponytail: plugins.includes("ponytail@") };
}

function main() {
  const root = parseArgs(process.argv.slice(2));
  const has = (path) => existsSync(join(root, path));
  const pkg = readJson(join(root, "package.json"));
  const mode = detectMode(root);
  const unknowns = [];
  const conflicts = [];

  const packageManager =
    pkg?.packageManager?.split("@")[0] ??
    PACKAGE_MANAGERS.find(([lockfile]) => has(lockfile))?.[1] ??
    (pkg ? "npm" : null);
  const [install, installCi, run, exec] = INSTALL[packageManager] ?? INSTALL.npm;

  const workspaceDirs = expandWorkspaces(root, workspaceGlobs(root, pkg));
  const manifests = [
    { dir: ".", pkg },
    ...workspaceDirs.map((dir) => ({ dir, pkg: readJson(join(root, dir, "package.json")) })),
  ].filter((manifest) => manifest.pkg);
  const allDeps = new Set(manifests.flatMap((manifest) => dependencies(manifest.pkg)));
  const uses = (list) => list.some((name) => allDeps.has(name));

  const apps = workspaceDirs.flatMap((dir) => {
    const appPkg = readJson(join(root, dir, "package.json"));
    const deps = new Set(dependencies(appPkg));
    const framework = FRAMEWORKS.find(([name]) => deps.has(name))?.[1];
    if (!framework) {
      return [];
    }
    unknowns.push(`apps[${dir}].APP_PURPOSE`);
    return [
      {
        APP_DIR: dir,
        APP_NAME: basename(dir),
        APP_FRAMEWORK: framework,
        APP_PURPOSE: "",
        APP_DEV: appPkg.scripts?.dev ? `cd ${dir} && ${run} dev` : "",
        APP_PORT: "—",
      },
    ];
  });

  const scripts = pkg?.scripts ?? {};
  const script = (...names) => {
    const name = names.find((candidate) => scripts[candidate]);
    return name ? `${run} ${name}` : "";
  };
  const defaultBranch =
    git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "") ||
    git(root, ["branch", "--show-current"]) ||
    "main";
  const scope = manifests
    .map((manifest) => manifest.pkg.name)
    .find((name) => typeof name === "string" && name.startsWith("@"))
    ?.split("/")[0];

  const linters = [
    ...[
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.ts",
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.json",
      ".eslintrc.cjs",
    ]
      .filter(has)
      .map(() => "eslint")
      .slice(0, 1),
    ...(has("biome.json") || has("biome.jsonc") ? ["biome"] : []),
    ...(has("oxlint.config.ts") || has(".oxlintrc.json") ? ["oxlint"] : []),
    ...(allDeps.has("prettier") ? ["prettier"] : []),
  ];
  const hooksPath = git(root, ["config", "core.hooksPath"]);
  const hooks = [
    ...(has(".husky") ? ["husky"] : []),
    ...(has("lefthook.yml") || has("lefthook.yaml") ? ["lefthook"] : []),
    ...(hooksPath ? [`core.hooksPath=${hooksPath}`] : []),
  ];
  const workflows = listDir(join(root, ".github", "workflows"))
    .filter((entry) => /\.ya?ml$/.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`);
  const agentSurface = [
    "AGENTS.md",
    "CLAUDE.md",
    ".cursorrules",
    ".cursor/rules",
    ".agents",
    ".claude/settings.json",
    "skills-lock.json",
    "context",
  ].filter(has);

  const ownLinter = linters.some((linter) => linter !== "prettier");
  const ownHooks = hooks.length > 0;
  const ownCi = workflows.length > 0;
  if (ownLinter) {
    conflicts.push(`linter present (${linters.join(", ")}) → OWN_LINTER: keep it; architecture rules go in oxlint`);
  }
  if (ownHooks) {
    conflicts.push(
      `git hooks present (${hooks.join(", ")}) → OWN_HOOKS: add our checks to them; never run install-hooks`,
    );
  }
  if (ownCi) {
    conflicts.push(`CI present (${workflows.join(", ")}) → OWN_CI: add steps to the PR workflow`);
  }
  if (agentSurface.length > 0) {
    conflicts.push(`agent docs present (${agentSurface.join(", ")}) → merge, never overwrite`);
  }

  const vars = {
    PROJECT_NAME: pkg?.name?.split("/").at(-1) ?? basename(root),
    PROJECT_SLUG: (pkg?.name?.split("/").at(-1) ?? basename(root)).toLowerCase(),
    PACKAGE_SCOPE: scope ?? "",
    ONE_LINER: pkg?.description ?? "",
    SETUP_DATE: new Date().toISOString().slice(0, 10),
    DEFAULT_BRANCH: defaultBranch,
    RUNTIME: packageManager === "bun" ? "bun" : "node",
    STACK_SUMMARY: FRAMEWORKS.filter(([name]) => allDeps.has(name))
      .map(([, label]) => label)
      .join(" · "),
    REQUEST_PATH: "",
    CMD_INSTALL: install,
    CMD_INSTALL_CI: installCi,
    CMD_DEV: script("dev"),
    CMD_LINT: script("lint"),
    CMD_FALLOW: `${run} fallow`,
    CMD_TYPECHECK: script("typecheck", "type-check", "check-types", "tsc"),
    CMD_TEST: script("test", "test:unit"),
    CMD_TEST_CHANGED: allDeps.has("vitest")
      ? `${exec} vitest run --changed origin/${defaultBranch}`
      : script("test", "test:unit"),
    CMD_E2E: script("test:e2e", "e2e"),
    AUTH_PACKAGE_PATTERNS: AUTH_DEPS.filter((name) => allDeps.has(name))
      .map((name) => `"${name}"`)
      .join(", "),
  };
  const required = ["ONE_LINER", "CMD_DEV", "CMD_LINT", "CMD_TYPECHECK", "CMD_TEST"];
  for (const key of uses(E2E_DEPS) ? [...required, "CMD_E2E"] : required) {
    if (vars[key] === "") {
      unknowns.push(`vars.${key}`);
    }
  }
  unknowns.push("vars.REQUEST_PATH", "flags.MULTI_TENANT", "flags.REQUEST_PATH_SET");

  const flags = {
    MONOREPO: workspaceDirs.length > 0,
    TYPESCRIPT: allDeps.has("typescript") || has("tsconfig.json"),
    BUN: packageManager === "bun",
    HAS_UI: uses(UI_DEPS),
    NEXTJS: allDeps.has("next"),
    HAS_DB: uses(DB_DEPS),
    HAS_AUTH: uses(AUTH_DEPS),
    MULTI_TENANT: false,
    HAS_AI: uses(AI_DEPS),
    HAS_JOBS: uses(JOB_DEPS),
    HAS_E2E: uses(E2E_DEPS),
    REQUEST_PATH_SET: false,
    GITHUB: has(".github") || git(root, ["remote", "get-url", "origin"]).includes("github.com"),
    CLAUDE_CODE: true,
    CLAUDE_SKILL_LINKS: true,
    ADOPT: mode === "adopt" || mode === "upgrade",
    OWN_LINTER: ownLinter,
    OWN_HOOKS: ownHooks,
    OWN_CI: ownCi,
  };

  const result = {
    mode,
    packageManager,
    draftAnswers: { vars, flags, apps: flags.MONOREPO ? apps : [] },
    unknowns,
    tooling: { linters, hooks, workflows, agentSurface, scripts: Object.keys(scripts) },
    workspaces: workspaceDirs,
    layerDirs: layerDirs(root),
    conflicts,
    tokenTools: tokenTools(),
  };
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[detect] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
