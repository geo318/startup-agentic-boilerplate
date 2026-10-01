import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { sha256 } from "./hash.ts";

export type Excerpt = { path: string; hash: string; reason: "mandatory" | "related"; tokens: number; text: string };
export type Packet = {
  excerpts: Excerpt[];
  omitted: Array<{ path: string; hash: string; tokens: number }>; // retrievable on demand via `read`
  tokens: number;
  budget: number;
};

export class ContextTooLarge extends Error {
  readonly reason = "insufficient context";
}

const approx = (s: string) => Math.ceil(s.length / 4);
const SKIP = new Set([".git", "node_modules", "dist", "coverage"]);
const TEXT = /\.(ts|tsx|js|jsx|mjs|json|md|css|sql|ya?ml)$/;

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && TEXT.test(e.name) && statSync(f).size < 200_000) out.push(relative(root, f).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}

const IMPORT_SPEC = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
const EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".json", "/index.ts", "/index.tsx", "/index.js"];

// Structural v1.1: mandatory files first (never truncated — too big means block/split), then at most
// `maxOptional` files that are *structurally* related: direct relative imports of a mandatory file, files that
// import a mandatory file (direct callers), and sibling tests. Word overlap with the goal is NOT used: common
// words ("year", "date", "test") pull in large unrelated files. Everything else is a retrievable manifest.
export function compile(root: string, mandatory: string[], budget: number, opts: { maxOptional?: number; maxOptionalTokens?: number } = {}): Packet {
  const maxOptional = opts.maxOptional ?? 2;
  const maxOptionalTokens = opts.maxOptionalTokens ?? 2000;
  const excerpts: Excerpt[] = [];
  let used = 0;
  const take = (path: string, reason: Excerpt["reason"]) => {
    const text = readFileSync(join(root, path), "utf8");
    return { path, hash: sha256(text), reason, tokens: approx(text), text };
  };
  for (const path of mandatory) {
    const e = take(path, "mandatory");
    used += e.tokens;
    if (used > budget) throw new ContextTooLarge(`mandatory ${path} does not fit (${used} > ${budget} tokens)`);
    excerpts.push(e);
  }
  const have = new Set(mandatory);
  const all = listFiles(root);
  const related = new Map<string, number>(); // path → rank (lower = more relevant)
  const rank = (f: string, r: number) => { if (!have.has(f) && (related.get(f) ?? 99) > r) related.set(f, r); };
  for (const m of mandatory) {
    const dir = dirname(m);
    const text = readFileSync(join(root, m), "utf8");
    for (const [, spec] of text.matchAll(IMPORT_SPEC)) {
      if (!spec!.startsWith(".")) continue;
      const base = posix.normalize(posix.join(dir, spec!));
      const hit = EXTS.map((x) => base + x).find((c) => all.includes(c));
      if (hit) rank(hit, 1); // direct dependency
    }
    const stem = posix.basename(m).replace(/\.[^.]+$/, "").replace(/\.(unit|integration)?\.?test$/, "");
    for (const f of all) if (posix.dirname(f) === dir && new RegExp(`^${stem}\\.[a-z.]*(test|spec)\\.`).test(posix.basename(f))) rank(f, 0); // sibling tests
  }
  const stems = mandatory.map((m) => posix.basename(m).replace(/\.[^.]+$/, ""));
  for (const f of all) {
    if (have.has(f) || !/\.(ts|tsx|js|jsx|mjs)$/.test(f)) continue;
    const body = readFileSync(join(root, f), "utf8");
    for (const [, spec] of body.matchAll(IMPORT_SPEC)) {
      if (spec!.startsWith(".") && stems.some((st) => spec!.endsWith(`/${st}`) || spec === `./${st}`) && have.has(posix.normalize(posix.join(posix.dirname(f), spec!)) + (EXTS.find((x) => have.has(posix.normalize(posix.join(posix.dirname(f), spec!)) + x)) ?? ""))) rank(f, 2); // direct caller
    }
  }
  const omitted: Packet["omitted"] = [];
  let optional = 0, optionalTokens = 0;
  const ordered = [...related.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([f]) => take(f, "related"));
  for (const e of ordered) {
    if (optional < maxOptional && optionalTokens + e.tokens <= maxOptionalTokens && used + e.tokens <= budget) {
      used += e.tokens; optional += 1; optionalTokens += e.tokens;
      excerpts.push(e);
    } else omitted.push({ path: e.path, hash: e.hash, tokens: e.tokens });
  }
  return { excerpts, omitted, tokens: used, budget };
}

export function render(p: Packet): string {
  const body = p.excerpts.map((e) => `--- ${e.path} (hash ${e.hash}; ${e.reason})\n${e.text}`).join("\n\n");
  const rest = p.omitted.length ? `\nNOT INCLUDED (use read): ${p.omitted.slice(0, 40).map((o) => o.path).join(", ")}` : "";
  return body + rest;
}
