// Setup variants, sync, installation, detection, and token audit regressions.
import assert from "node:assert/strict";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const scaffold = join(root, "project-setup/scripts/scaffold.mjs");
const base = JSON.parse(readFileSync(join(root, "test/fixtures/answers.json"), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "var-"));
const sha = (t) => createHash("sha256").update(t).digest("hex");

function answers(patch = {}) {
  const a = {
    vars: { ...base.vars, ...patch.vars },
    flags: { ...base.flags, ...patch.flags },
    apps: patch.apps ?? base.apps,
  };
  const f = join(tmp(), "a.json");
  writeFileSync(f, JSON.stringify(a));
  return f;
}
const render = (patch, extra = []) => {
  const t = tmp();
  const r = spawnSync(process.execPath, [scaffold, "--answers", answers(patch), "--target", t, ...extra], {
    encoding: "utf8",
  });
  return { t, r };
};
function files(dir, out = [], rel = "") {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    e.isDirectory() ? files(dir, out, p) : out.push(p);
  }
  return out;
}
const noLeftovers = (t) => {
  for (const f of files(t).filter((f) => /\.(md|json|ya?ml|mjs)$/.test(f))) {
    assert.doesNotMatch(readFileSync(join(t, f), "utf8"), /\{\{[#/]?[A-Z!a-z]/, `unresolved template syntax in ${f}`);
  }
};

const app = (dir) => ({ ...base.apps[0], APP_DIR: dir });
const variants = {
  "typescript + github (base)": { patch: {}, has: [".github/workflows/ci.yml", "biome.json"], hasNot: [] },
  "no github": { patch: { flags: { GITHUB: false } }, has: ["AGENTS.md"], hasNot: [".github", ".agents/routines"] },
  "non-typescript": {
    patch: { flags: { TYPESCRIPT: false } },
    has: ["AGENTS.md"],
    hasNot: ["biome.json", "tsconfig.base.json", ".fallowrc.json"],
  },
  "monorepo (two apps)": {
    patch: { flags: { MONOREPO: true }, apps: [app("apps/web"), app("apps/api")] },
    has: ["apps/web/AGENTS.md", "apps/api/AGENTS.md"],
    hasNot: [],
  },
  "docs-only (no apps, no claude)": {
    patch: { apps: [], flags: { TYPESCRIPT: false, CLAUDE_CODE: false } },
    has: ["context/README.md"],
    hasNot: [".claude"],
  },
  "adopt existing project": {
    patch: { flags: { ADOPT: true } },
    has: ["context/plans/adoption.md"],
    hasNot: [".fallowrc.json"],
  },
  "existing tooling": {
    patch: { flags: { ADOPT: true, OWN_LINTER: true, OWN_HOOKS: true, OWN_CI: true } },
    has: [".github/workflows/merge-gate.yml"],
    hasNot: ["biome.json", ".githooks", ".github/workflows/ci.yml"],
  },
  "full UI, auth, database, AI and Bun": {
    patch: {
      flags: { HAS_UI: true, HAS_AUTH: true, HAS_DB: true, MULTI_TENANT: true, HAS_AI: true, HAS_E2E: true, BUN: true, NEXTJS: true, REQUEST_PATH_SET: true },
      vars: { CMD_E2E: "npm run test:e2e", AUTH_PACKAGE_PATTERNS: '"better-auth"', REQUEST_PATH: "UI → API → database" },
    },
    has: ["context/architecture/ai.md", "context/standards/react.md"],
    hasNot: [],
  },
};
for (const [name, v] of Object.entries(variants)) {
  test(`variant renders cleanly: ${name}`, () => {
    const { t, r } = render(v.patch);
    assert.equal(r.status, 0, r.stderr);
    for (const f of v.has) assert.ok(existsSync(join(t, f)), `expected ${f}`);
    for (const f of v.hasNot) assert.ok(!existsSync(join(t, f)), `unexpected ${f}`);
    noLeftovers(t);
    for (const f of files(t).filter((f) => f.endsWith(".json"))) {
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(t, f), "utf8")), f);
    }
    for (const f of files(t).filter((f) => f.endsWith(".md"))) {
      writeFileSync(join(t, f), readFileSync(join(t, f), "utf8").replace(/<!-- FILL:[\s\S]*?-->/g, "Fixture."));
    }
    const check = spawnSync(process.execPath, [join(t, "scripts/checks/docs-check.mjs"), "--root", t], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  });
}

test("git convention validation accepts kebab case and rejects malformed segments", () => {
  const script = join(root, "project-setup/templates/scripts/git/conventions.mjs");
  for (const [name, valid] of [["fix-2", true], ["a", true], ["", false], ["-a", false], ["a-", false], ["a--b", false], ["Upper", false], ["a_b", false], ["a/b", false]]) {
    for (const [command, value] of [["branch", `feat/${name}`], ["title", `fix(${name}): repair bug`]]) {
      const r = spawnSync(process.execPath, [script, command, value], { encoding: "utf8" });
      assert.equal(r.status === 0, valid, `${command}: ${value}`);
    }
  }
});

test("detector distinguishes default branches from the checked-out feature branch", () => {
  const t = tmp();
  writeFileSync(join(t, "package.json"), JSON.stringify({
    devDependencies: { vitest: "1.0.0" }, scripts: { test: "vitest run" },
  }));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: t, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  const detect = () => {
    const r = spawnSync(process.execPath, [join(root, "project-setup/scripts/detect.mjs"), "--target", t], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  git("init", "-b", "main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "initial");
  git("checkout", "-b", "feat/work");
  assert.equal(detect().draftAnswers.vars.DEFAULT_BRANCH, "main");
  assert.equal(detect().draftAnswers.vars.CMD_TEST_CHANGED, "npm run test");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(detect().draftAnswers.vars.CMD_TEST_CHANGED, "npx vitest run --changed origin/main");
  git("update-ref", "-d", "refs/remotes/origin/main");
  git("branch", "-m", "main", "trunk");
  assert.equal(detect().draftAnswers.vars.DEFAULT_BRANCH, "");
  assert.ok(detect().unknowns.includes("vars.DEFAULT_BRANCH"));
  assert.equal(detect().draftAnswers.vars.CMD_TEST_CHANGED, "npm run test");
  git("update-ref", "refs/remotes/origin/trunk", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  assert.equal(detect().draftAnswers.vars.DEFAULT_BRANCH, "trunk");
  assert.equal(detect().draftAnswers.vars.CMD_TEST_CHANGED, "npx vitest run --changed origin/trunk");
  git("update-ref", "-d", "refs/remotes/origin/trunk");
  assert.equal(detect().draftAnswers.vars.CMD_TEST_CHANGED, "npm run test");
});

test("detector rejects missing targets and malformed manifests", () => {
  const t = tmp();
  writeFileSync(join(t, "package.json"), "{ broken");
  for (const target of [t, join(t, "missing")]) {
    const r = spawnSync(process.execPath, [join(root, "project-setup/scripts/detect.mjs"), "--target", target], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
  }
});

test("lean hooks enforce docs budgets without invoking fallow or requiring its command", () => {
  const { t, r } = render({ flags: { LEAN: true }, vars: { CMD_FALLOW: undefined } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(readFileSync(join(t, ".claude/settings.json"), "utf8"), /fallow/);
  mkdirSync(join(t, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(t, "node_modules/.bin/fallow"), "#!/bin/sh\necho unexpected-fallow >&2\nexit 9\n");
  chmodSync(join(t, "node_modules/.bin/fallow"), 0o755);
  writeFileSync(join(t, "scripts/checks/docs-check.mjs"), 'if (!process.argv.includes("--strict")) process.exit(8);\n');
  const init = spawnSync("git", ["init", "-b", "main"], { cwd: t, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const hook = spawnSync(process.execPath, [join(t, "scripts/checks/agent-stop.mjs")], {
    cwd: t, input: "{}", encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: t },
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(readFileSync(join(t, ".githooks/pre-push"), "utf8"), /docs-check\.mjs --strict/);
});

test("non-TypeScript pre-push runs lint and propagates its failure", () => {
  const { t, r } = render({ flags: { TYPESCRIPT: false }, vars: { CMD_LINT: "node lint.mjs" } });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(t, "scripts/git/conventions.mjs"), "");
  writeFileSync(join(t, "scripts/checks/docs-check.mjs"), "");
  writeFileSync(join(t, "lint.mjs"), 'console.error("lint failed"); process.exit(7);\n');
  const hook = spawnSync("sh", [join(t, ".githooks/pre-push")], { cwd: t, encoding: "utf8" });
  assert.notEqual(hook.status, 0);
  assert.match(hook.stderr, /lint failed/);
});

test("lock records the generator and a deterministic templates hash", () => {
  const a = render({}),
    b = render({});
  const la = JSON.parse(readFileSync(join(a.t, "docs/archive/project-setup.lock.json"), "utf8"));
  const lb = JSON.parse(readFileSync(join(b.t, "docs/archive/project-setup.lock.json"), "utf8"));
  assert.match(la.$meta.templatesHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(la, lb);
});

test("upgrade (--sync): untouched file with a changed template is updated; edited+changed goes to merge dir", () => {
  const { t } = render({});
  const lockPath = join(t, "docs/archive/project-setup.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  // simulate "template changed since render": file holds old content whose hash the lock still records
  writeFileSync(join(t, "docs/README.md"), "old render\n");
  lock["docs/README.md"] = sha("old render\n");
  // simulate "user edited AND template changed": lock records some other old render
  writeFileSync(join(t, "docs/local-setup.md"), "my edits\n");
  lock["docs/local-setup.md"] = sha("an older render\n");
  writeFileSync(lockPath, JSON.stringify(lock));
  const r = spawnSync(process.execPath, [scaffold, "--answers", answers(), "--target", t, "--sync"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(readFileSync(join(t, "docs/README.md"), "utf8"), "old render\n");
  assert.equal(readFileSync(join(t, "docs/local-setup.md"), "utf8"), "my edits\n"); // user's file untouched
  assert.ok(existsSync(join(t, ".project-setup/sync/docs/local-setup.md")));
  assert.match(r.stdout, /merge 1 files/);
});

test("dry-run on an adopted project reports conflicts and writes nothing", () => {
  const { t } = render({});
  writeFileSync(join(t, "AGENTS.md"), "mine\n");
  const before = files(t).map((f) => [f, sha(readFileSync(join(t, f)))]);
  const r = spawnSync(process.execPath, [scaffold, "--answers", answers(), "--target", t, "--dry-run"], {
    encoding: "utf8",
  });
  assert.match(r.stdout, /= AGENTS\.md/);
  assert.deepEqual(
    files(t).map((f) => [f, sha(readFileSync(join(t, f)))]),
    before,
  );
});

// ---------- installer ----------
const install = join(root, "install.sh");
const sh = (args, env = {}) =>
  spawnSync("sh", [install, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("install.sh: project install copies; --link symlinks; reinstall refused; bad dir and no args fail", () => {
  const p = tmp();
  assert.equal(sh([p]).status, 0);
  assert.ok(lstatSync(join(p, ".agents/skills/project-setup")).isDirectory());
  assert.ok(lstatSync(join(p, ".claude/skills/project-setup")).isSymbolicLink());
  assert.equal(
    realpathSync(join(p, ".claude/skills/project-setup")),
    realpathSync(join(p, ".agents/skills/project-setup")),
  );
  assert.notEqual(sh([p]).status, 0);
  const l = tmp();
  assert.equal(sh([l, "--link"]).status, 0);
  assert.ok(lstatSync(join(l, ".agents/skills/project-setup")).isSymbolicLink());
  assert.equal(realpathSync(join(l, ".claude/skills/project-setup")), realpathSync(join(root, "project-setup")));
  assert.notEqual(sh(["/nonexistent/dir"]).status, 0);
  assert.notEqual(sh([]).status, 0);
});

test("install.sh --global writes only under HOME", () => {
  const home = tmp();
  assert.equal(sh(["--global"], { HOME: home }).status, 0);
  assert.ok(existsSync(join(home, ".agents/skills/project-setup/SKILL.md")));
  assert.ok(lstatSync(join(home, ".claude/skills/project-setup")).isSymbolicLink());
});

test("installer refuses existing Claude installs and dangling links before writing", () => {
  for (const dangling of [false, true]) {
    const p = tmp();
    mkdirSync(join(p, ".claude/skills"), { recursive: true });
    const path = join(p, ".claude/skills/project-setup");
    if (dangling) symlinkSync("missing", path);
    else mkdirSync(path);
    assert.notEqual(sh([p]).status, 0);
    assert.equal(existsSync(join(p, ".agents")), false);
  }
});

test("detector recognizes a fresh harness-only project without enabling Claude", () => {
  const p = tmp();
  mkdirSync(join(p, ".agents/skills"), { recursive: true });
  mkdirSync(join(p, ".codex"));
  writeFileSync(join(p, "plan.md"), "# plan\n");
  const r = spawnSync(process.execPath, [join(root, "project-setup/scripts/detect.mjs"), "--target", p], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const detected = JSON.parse(r.stdout);
  assert.equal(detected.mode, "new");
  assert.equal(detected.draftAnswers.flags.CLAUDE_CODE, false);
  mkdirSync(join(p, ".claude"));
  const claude = spawnSync(process.execPath, [join(root, "project-setup/scripts/detect.mjs"), "--target", p], {
    encoding: "utf8",
  });
  assert.equal(JSON.parse(claude.stdout).draftAnswers.flags.CLAUDE_CODE, true);
});

test("token audit counts canonical skills once across Claude symlinks", () => {
  const p = tmp(),
    home = tmp();
  mkdirSync(join(p, ".agents/skills/example"), { recursive: true });
  writeFileSync(join(p, ".agents/skills/example/SKILL.md"), "---\nname: example\ndescription: Example\n---\n");
  mkdirSync(join(p, ".claude/skills"), { recursive: true });
  symlinkSync("../../.agents/skills/example", join(p, ".claude/skills/example"));
  const r = spawnSync(process.execPath, [join(root, "project-setup/scripts/token-audit.mjs"), "--target", p], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const audit = JSON.parse(r.stdout);
  assert.equal(audit.skills.count, 1);
  assert.equal(audit.usageSource, "claude-code-only");
});

test("lean setup keeps commands and checks, omits generic architecture prose, and has valid links", () => {
  const { t, r } = render({ flags: { LEAN: true } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(t, "context/architecture/domain-modules.md")));
  assert.ok(!existsSync(join(t, ".fallowrc.json")));
  assert.ok(!existsSync(join(t, ".agents/skills/architect")));
  assert.ok(readFileSync(join(t, "AGENTS.md"), "utf8").length / 4 < 1500);
  for (const f of files(t).filter((f) => f.endsWith(".md"))) {
    const body = readFileSync(join(t, f), "utf8").replace(/<!-- FILL:[\s\S]*?-->/g, "Setup fixture.");
    writeFileSync(join(t, f), body);
  }
  const check = spawnSync(process.execPath, [join(t, "scripts/checks/docs-check.mjs"), "--root", t, "--strict"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  noLeftovers(t);
  writeFileSync(join(t, "package.json"), JSON.stringify({ dependencies: { example: "1.0.0" } }));
  const missing = spawnSync(process.execPath, [join(t, "scripts/checks/docs-check.mjs"), "--root", t], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /example.*official docs/);
  assert.doesNotMatch(missing.stderr, /add-library-skill/);
});

test("token inventory counts Codex skills, folded descriptions, and imported instructions once", () => {
  const home = tmp(),
    target = tmp();
  mkdirSync(join(home, ".codex/skills/folded"), { recursive: true });
  writeFileSync(
    join(home, ".codex/skills/folded/SKILL.md"),
    `---\nname: folded\ndescription: >\n  ${"A useful description. ".repeat(40)}\n---\n`,
  );
  writeFileSync(join(target, "AGENTS.md"), "@rules.md\n");
  writeFileSync(join(target, "rules.md"), "@AGENTS.md\nKeep edits small.\n");
  const result = spawnSync(
    process.execPath,
    [join(root, "project-setup/scripts/token-audit.mjs"), "--target", target, "--harness", "codex"],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.skills.count, 1);
  assert.ok(data.skills.tokens > 200);
  assert.equal(data.instructionFiles.length, 2);
  assert.deepEqual(data.skills.unused, []); // no telemetry is not evidence of non-use
});

test("mixed-harness inventories never infer skill non-use from Claude-only transcripts", () => {
  const home = tmp(),
    target = tmp();
  for (const skill of [".codex/skills/codex-only", ".claude/skills/claude-only"]) {
    mkdirSync(join(home, skill), { recursive: true });
    writeFileSync(join(home, skill, "SKILL.md"), "---\nname: example\ndescription: Example skill.\n---\n");
  }
  const transcripts = join(home, ".claude/projects", target.replace(/[/.]/g, "-"));
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(transcripts, "session.jsonl"), '{"type":"assistant","message":{"content":[]}}\n');
  for (const harness of ["all", "codex", "claude"]) {
    const result = spawnSync(
      process.execPath,
      [join(root, "project-setup/scripts/token-audit.mjs"), "--target", target, "--harness", harness],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.sessionsScanned, harness === "codex" ? 0 : 1);
    assert.deepEqual(data.skills.unused, harness === "claude" ? ["claude-only"] : []);
  }
});


test("lean CI rejects oversized docs while full CI retains warning mode", () => {
  for (const lean of [false, true]) {
    const { t, r } = render({ flags: { LEAN: lean } });
    assert.equal(r.status, 0, r.stderr);
    for (const f of files(t).filter((f) => f.endsWith(".md"))) {
      writeFileSync(join(t, f), readFileSync(join(t, f), "utf8").replace(/<!-- FILL:[\s\S]*?-->/g, "Fixture."));
    }
    writeFileSync(join(t, "AGENTS.md"), readFileSync(join(t, "AGENTS.md"), "utf8") + "\n" + "Oversized documentation. ".repeat(400));
    const workflow = readFileSync(join(t, ".github/workflows/ci.yml"), "utf8");
    const command = workflow.match(/- name: Docs\s+run: "([^"\n]+)"/)[1];
    const result = spawnSync(command, { cwd: t, shell: true, encoding: "utf8" });
    assert.equal(result.status, lean ? 1 : 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /budget/);
  }
});

test("token configuration inventory respects the selected harness", () => {
  const home = tmp(), target = tmp();
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(target, ".codex"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { claudeUser: {} } }));
  writeFileSync(join(target, ".mcp.json"), JSON.stringify({ mcpServers: { claudeProject: {} } }));
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "claude-plugin": true } }));
  writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.codexUser]\ncommand = "example"\n');
  writeFileSync(join(target, ".codex/config.toml"), '[mcp_servers."codex.project"] # quoted name\ncommand = "example"\n');
  for (const harness of ["codex", "claude", "all"]) {
    const result = spawnSync(process.execPath,
      [join(root, "project-setup/scripts/token-audit.mjs"), "--target", target, "--harness", harness],
      { encoding: "utf8", env: { ...process.env, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    const expected = [
      ...(harness !== "codex" ? ["claudeUser", "claudeProject"] : []),
      ...(harness !== "claude" ? ["codexUser", "codex.project"] : []),
    ];
    assert.deepEqual(data.mcpServers.configured.sort(), expected.sort());
    assert.deepEqual(data.enabledPlugins, harness === "codex" ? [] : ["claude-plugin"]);
    assert.equal(data.codexConfigFiles.length, harness === "claude" ? 0 : 2);
  }
});
