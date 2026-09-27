// Architecture contract: import boundaries and forbidden calls, with an explicit debt baseline.
//
// Edit RULES to match context/architecture.md. A baseline entry records existing debt exactly
// (file + count + reason) so it can shrink without a flag-day refactor; it is never an example to
// copy. New violations fail; so do stale baseline entries, which forces the baseline to shrink.

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
    for (const rule of IMPORT_RULES) {
      if (matchesPrefix(path, rule.from)) {
        add(
          rule.name,
          path,
          importSpecifiers(source).filter((spec) => forbidden(spec, rule.forbid)).length,
        );
      }
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
