// Architecture contract: import boundaries and forbidden calls, with an explicit debt baseline.
//
// Edit RULES to match context/architecture.md. A baseline entry records existing debt exactly
// (file + count + reason) so it can shrink without a flag-day refactor; it is never an example to
// copy. New violations fail; so do stale baseline entries, which forces the baseline to shrink.

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ImportRule {
  name: string;
  /** Repo-relative path prefixes the rule applies to. */
  from: string[];
  /** Import specifiers (exact or as a prefix followed by "/") that those files must not import. */
  forbid: string[];
  reason: string;
}

interface CallRule {
  name: string;
  /** Source text that counts as a use, e.g. "fetch(". */
  call: string;
  /** Repo-relative path prefixes where the call is allowed without a baseline entry. */
  allowIn: string[];
  reason: string;
}

interface EntryRule {
  name: string;
  /** Repo-relative folders whose direct subfolders are modules, e.g. "packages/core/src". */
  roots: string[];
  /** Import prefixes that resolve into the repo, e.g. { "@/": "apps/web/src/" }. */
  aliases: Record<string, string>;
  /** Module folder names exempt from the rule, e.g. the shared kernel. */
  exempt: string[];
  reason: string;
}

interface BaselineEntry {
  rule: string;
  path: string;
  count: number;
  reason: string;
}

// Default depth matches the recommended location, packages/core/src/. FIXME(setup): confirm.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".expo",
  "coverage",
]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

const IMPORT_RULES: ImportRule[] = [
  {
    name: "routes-are-transport-only",
    from: ["apps/api/src/routes"],
    forbid: ["@scope/db"],
    reason: "Routes delegate to services; persistence stays behind repositories.",
  },
  {
    name: "core-is-framework-free",
    from: ["packages/core/src"],
    forbid: ["@scope/db", "drizzle-orm", "next", "react", "elysia", "hono"],
    reason: "Domain and use cases depend on ports; adapters and frameworks depend on core.",
  },
  {
    name: "ui-does-not-touch-the-database",
    from: ["apps/web"],
    forbid: ["@scope/db", "drizzle-orm"],
    reason: "UI → hook → client DAL → HTTP; database access is server-only.",
  },
];

const CALL_RULES: CallRule[] = [
  {
    name: "one-http-client",
    call: "fetch(",
    allowIn: [],
    reason: "All HTTP goes through the shared client; exceptions need a recorded reason.",
  },
];

const ENTRY_RULES: EntryRule[] = [
  {
    name: "modules-import-each-other-through-index",
    roots: ["packages/core/src", "apps/web/src/features"],
    aliases: { "@/": "apps/web/src/" },
    exempt: ["shared"],
    reason: "A module's index.ts is its public API; everything behind it is internal.",
  },
];

const BASELINE: BaselineEntry[] = [];

function isTest(path: string): boolean {
  return path.includes(".test.") || path.includes(".spec.");
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        walk(full);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
      ) {
        const path = relative(repoRoot, full).split(sep).join("/");
        if (!isTest(path)) {
          files.push(path);
        }
      }
    }
  };
  for (const root of SOURCE_ROOTS) {
    walk(join(repoRoot, root));
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const marker of [' from "', " from '", 'import("', "import('", 'require("', "require('"]) {
    let index = source.indexOf(marker);
    while (index >= 0) {
      const start = index + marker.length;
      const quote = marker.at(-1) ?? '"';
      const end = source.indexOf(quote, start);
      if (end > start) {
        specifiers.push(source.slice(start, end));
      }
      index = source.indexOf(marker, start);
    }
  }
  return specifiers;
}

function matchesPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function forbidden(specifier: string, forbid: string[]): boolean {
  return forbid.some((module) => specifier === module || specifier.startsWith(`${module}/`));
}

function resolveSpecifier(
  fromPath: string,
  specifier: string,
  aliases: Record<string, string>,
): string | null {
  if (specifier.startsWith(".")) {
    return posix.join(posix.dirname(fromPath), specifier);
  }
  for (const [prefix, target] of Object.entries(aliases)) {
    if (specifier.startsWith(prefix)) {
      return posix.join(target, specifier.slice(prefix.length));
    }
  }
  return null;
}

function stripExtension(path: string): string {
  const extension = [...SOURCE_EXTENSIONS, ".js"].find((candidate) => path.endsWith(candidate));
  return extension === undefined ? path : path.slice(0, -extension.length);
}

/** Counts imports that reach past another module's entry point (its folder or `index`). */
function deepModuleImports(path: string, specifiers: string[], rule: EntryRule): number {
  let count = 0;
  for (const specifier of specifiers) {
    const target = resolveSpecifier(path, specifier, rule.aliases);
    if (target === null) {
      continue;
    }
    for (const root of rule.roots) {
      if (!target.startsWith(`${root}/`)) {
        continue;
      }
      const [module, ...rest] = stripExtension(target.slice(root.length + 1)).split("/");
      if (module === undefined || rule.exempt.includes(module)) {
        continue;
      }
      const ownModule = path.startsWith(`${root}/${module}/`);
      const isEntry = rest.length === 0 || (rest.length === 1 && rest[0] === "index");
      if (!ownModule && !isEntry) {
        count += 1;
      }
    }
  }
  return count;
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let index = source.indexOf(needle);
  while (index >= 0) {
    const before = source[index - 1] ?? " ";
    const isMember = before === "." || before === "_" || (before >= "a" && before <= "z");
    if (!isMember) {
      count += 1;
    }
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

function collectViolations(): Map<string, number> {
  const violations = new Map<string, number>();
  const add = (rule: string, path: string, count: number) => {
    if (count > 0) {
      violations.set(`${rule}::${path}`, (violations.get(`${rule}::${path}`) ?? 0) + count);
    }
  };
  for (const path of sourceFiles()) {
    const source = readFileSync(join(repoRoot, path), "utf8");
    const specifiers = importSpecifiers(source);
    for (const rule of IMPORT_RULES) {
      if (matchesPrefix(path, rule.from)) {
        add(rule.name, path, specifiers.filter((spec) => forbidden(spec, rule.forbid)).length);
      }
    }
    for (const rule of ENTRY_RULES) {
      add(rule.name, path, deepModuleImports(path, specifiers, rule));
    }
    for (const rule of CALL_RULES) {
      if (!matchesPrefix(path, rule.allowIn)) {
        add(rule.name, path, countOccurrences(source, rule.call));
      }
    }
  }
  return violations;
}

describe("architecture contract", () => {
  const violations = collectViolations();
  const baseline = new Map(BASELINE.map((entry) => [`${entry.rule}::${entry.path}`, entry.count]));

  it("adds no violations beyond the recorded baseline", () => {
    const unexpected = [...violations]
      .filter(([key, count]) => count > (baseline.get(key) ?? 0))
      .map(([key, count]) => `${key} (found ${count}, baseline ${baseline.get(key) ?? 0})`);
    expect(unexpected).toEqual([]);
  });

  it("keeps the baseline exact so fixed debt is removed from it", () => {
    const stale = [...baseline]
      .filter(([key, count]) => (violations.get(key) ?? 0) < count)
      .map(([key, count]) => `${key} (baseline ${count}, found ${violations.get(key) ?? 0})`);
    expect(stale).toEqual([]);
  });
});
