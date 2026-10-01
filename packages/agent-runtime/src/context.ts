import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { sha256 } from "./hash.ts";

export type Excerpt = { path: string; hash: string; reason: "mandatory" | "keyword"; tokens: number; text: string };
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

// Lexical v1: mandatory files first (never truncated — too big means block/split), then optional files
// scored by how many goal words they contain, added while the budget lasts. The rest is a manifest.
export function compile(root: string, mandatory: string[], goal: string, budget: number): Packet {
  const excerpts: Excerpt[] = [];
  let used = 0;
  const take = (path: string, reason: Excerpt["reason"]) => {
    const text = readFileSync(join(root, path), "utf8");
    const tokens = approx(text);
    return { path, hash: sha256(text), reason, tokens, text };
  };
  for (const path of mandatory) {
    const e = take(path, "mandatory");
    used += e.tokens;
    if (used > budget) throw new ContextTooLarge(`mandatory ${path} does not fit (${used} > ${budget} tokens)`);
    excerpts.push(e);
  }
  const words = [...new Set(goal.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? [])];
  const have = new Set(mandatory);
  const scored = listFiles(root)
    .filter((f) => !have.has(f))
    .map((f) => {
      const e = take(f, "keyword");
      const body = e.text.toLowerCase();
      return { e, score: words.filter((w) => body.includes(w) || f.toLowerCase().includes(w)).length };
    })
    .sort((a, b) => b.score - a.score || (a.e.path < b.e.path ? -1 : 1));
  const omitted: Packet["omitted"] = [];
  for (const { e, score } of scored) {
    if (score > 0 && used + e.tokens <= budget) {
      used += e.tokens;
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
