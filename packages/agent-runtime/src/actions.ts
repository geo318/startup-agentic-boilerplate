import type { Edit } from "./edits.ts";

export type Action =
  | { id: string; kind: "read"; path: string }
  | { id: string; kind: "edit"; edits: Edit[] }
  | { id: string; kind: "run_gate"; gateId: string }
  | { id: string; kind: "finish" }
  | { id: string; kind: "blocked"; reason: string };

export class InvalidAction extends Error {
  readonly reason = "policy violation";
}

const KEYS: Record<string, string[]> = {
  read: ["id", "kind", "path"],
  edit: ["id", "kind", "edits"],
  run_gate: ["id", "kind", "gateId"],
  finish: ["id", "kind"],
  blocked: ["id", "kind", "reason"],
};
const EDIT_KEYS: Record<string, string[]> = {
  replace: ["kind", "path", "expectHash", "find", "replace"],
  create: ["kind", "path", "content"],
  replace_file: ["kind", "path", "expectHash", "content"],
};

const isStr = (v: unknown): v is string => typeof v === "string" && v.length <= 200_000;
function closed(o: Record<string, unknown>, keys: string[], what: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new InvalidAction(`${what}: unknown field ${k}`);
  for (const k of keys)
    if (!isStr(o[k]) && !(k === "edits" && Array.isArray(o[k]))) throw new InvalidAction(`${what}: bad field ${k}`);
}

// Closed-object validation of untrusted model output. Anything unrecognised is rejected, never repaired.
export function parseAction(raw: unknown): Action {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InvalidAction("not an object");
  const o = raw as Record<string, unknown>;
  const keys = typeof o.kind === "string" ? KEYS[o.kind] : undefined;
  if (!keys) throw new InvalidAction(`unsupported action kind: ${String(o.kind)}`);
  closed(o, keys, String(o.kind));
  if (o.kind === "edit") {
    const edits = o.edits as unknown[];
    if (edits.length === 0 || edits.length > 20) throw new InvalidAction("edit: 1-20 edits required");
    for (const e of edits) {
      if (!e || typeof e !== "object") throw new InvalidAction("edit: bad entry");
      const eo = e as Record<string, unknown>;
      const ek = typeof eo.kind === "string" ? EDIT_KEYS[eo.kind] : undefined;
      if (!ek) throw new InvalidAction("edit: unsupported edit kind");
      closed(eo, ek, "edit");
    }
  }
  return o as Action;
}

// JSON Schema handed to providers that support constrained output. Providers differ: the Claude CLI's structured
// output needs a top-level object (a top-level oneOf made every call fail, measured live), so this is one flat,
// closed object. It stops unknown fields but cannot forbid a known field in the wrong place (e.g. `path` on an edit);
// parseAction rejects those independently and the driver feeds the exact error back for one retry.
const str = { type: "string" } as const;
export const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind"],
  properties: {
    id: str,
    kind: { enum: ["read", "edit", "run_gate", "finish", "blocked"] },
    path: str,
    gateId: str,
    reason: str,
    edits: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path"],
        properties: {
          kind: { enum: ["replace", "create", "replace_file"] },
          path: str,
          expectHash: str,
          find: str,
          replace: str,
          content: str,
        },
      },
    },
  },
} as const;
