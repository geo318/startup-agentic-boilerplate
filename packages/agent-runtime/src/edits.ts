import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "./hash.ts";
import { PathRejected, resolveSafe } from "./paths.ts";

export type Edit =
  | { kind: "replace"; path: string; expectHash: string; find: string; replace: string }
  | { kind: "create"; path: string; content: string };

export class EditRejected extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

const MAX_BYTES = 256 * 1024;

// All-or-nothing: every edit is validated and computed in memory first; writes happen only if all pass.
export function applyEdits(root: string, edits: Edit[], protectedPaths: string[]): string[] {
  const planned = new Map<string, string>();
  for (const e of edits) {
    const abs = resolveSafe(root, e.path, protectedPaths);
    if (planned.has(abs)) throw new EditRejected("policy violation", `two edits to ${e.path}`);
    if (e.kind === "create") {
      if (existsSync(abs)) throw new EditRejected("stale evidence", `exists: ${e.path}`);
      if (e.content.includes("\0") || Buffer.byteLength(e.content) > MAX_BYTES) {
        throw new EditRejected("policy violation", `binary or oversized: ${e.path}`);
      }
      planned.set(abs, e.content);
      continue;
    }
    if (!existsSync(abs)) throw new EditRejected("insufficient context", `missing: ${e.path}`);
    const current = readFileSync(abs, "utf8");
    if (sha256(current) !== e.expectHash) throw new EditRejected("stale evidence", `stale content: ${e.path}`);
    if (!e.find) throw new EditRejected("insufficient context", "empty find");
    const first = current.indexOf(e.find);
    if (first < 0) throw new EditRejected("insufficient context", `span not found: ${e.path}`);
    if (current.indexOf(e.find, first + 1) >= 0) throw new EditRejected("insufficient context", `ambiguous span: ${e.path}`);
    const next = current.slice(0, first) + e.replace + current.slice(first + e.find.length);
    if (Buffer.byteLength(next) > MAX_BYTES) throw new EditRejected("policy violation", `oversized: ${e.path}`);
    planned.set(abs, next);
  }
  // Commit: stage temp files, then rename; undo on any failure.
  const backups: Array<[string, string | null]> = [];
  try {
    for (const [abs, content] of planned) {
      backups.push([abs, existsSync(abs) ? readFileSync(abs, "utf8") : null]);
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.agentic-tmp`;
      writeFileSync(tmp, content);
      renameSync(tmp, abs);
    }
  } catch (err) {
    for (const [abs, old] of backups.reverse()) {
      if (old === null) rmSync(abs, { force: true });
      else writeFileSync(abs, old);
    }
    throw err;
  }
  return [...planned.keys()];
}

export { PathRejected };
