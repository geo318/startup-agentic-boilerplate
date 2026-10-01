import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_SCHEMA, parseAction } from "./actions.ts";
import { applyEdits } from "./edits.ts";
import { sha256 } from "./hash.ts";
import type { GenerationProvider } from "./provider.ts";
import type { RiskTier } from "./run.ts";

// Roles map to separately evidenced families. A passed action-protocol probe never qualifies a model
// to architect or review: those need an eval result or an explicit owner declaration.
export type Family = "action-protocol" | "architecture" | "review";
export type Qualification = {
  profileId: string; family: Family; source: "probe" | "eval" | "owner-declared";
  passed: boolean; detail: Record<string, string>; at: string;
};

export class QualStore {
  #file: string;
  constructor(file: string) {
    this.#file = file;
  }
  all(): Qualification[] {
    return existsSync(this.#file) ? JSON.parse(readFileSync(this.#file, "utf8")) : [];
  }
  record(q: Qualification): void {
    // A newer record for the same profile+family replaces the old one: changing the profile id invalidates it.
    const rest = this.all().filter((x) => !(x.profileId === q.profileId && x.family === q.family));
    mkdirSync(join(this.#file, ".."), { recursive: true });
    writeFileSync(this.#file, JSON.stringify([...rest, q], null, 2));
  }
  has(profileId: string, family: Family): boolean {
    return this.all().some((q) => q.profileId === profileId && q.family === family && q.passed);
  }
}

// Probes: valid output + a real patch applied to a scratch file. Cancellation and context-fit are reported
// as not probed rather than assumed.
export async function probeActionProtocol(p: GenerationProvider, store: QualStore): Promise<Qualification> {
  const detail: Record<string, string> = { cancellation: "not-probed", context_fit: "not-probed" };
  const sys = 'Reply with ONE JSON object only. Allowed kinds: finish, edit (edits:[{kind:"replace",path,expectHash,find,replace}]).';
  try {
    const a = await p.generate({ system: sys, prompt: 'Reply with the finish action: {"id":"p1","kind":"finish"}', maxOutputTokens: 100, schema: ACTION_SCHEMA });
    detail.valid_output = parseAction(JSON.parse(a.content)).kind === "finish" && a.finishReason === "stop" ? "pass" : "fail";
  } catch {
    detail.valid_output = "fail";
  }
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  writeFileSync(join(dir, "f.txt"), "alpha");
  try {
    const b = await p.generate({
      system: sys,
      prompt: `File f.txt (hash ${sha256("alpha")}) contains: alpha\nReply with one edit action replacing "alpha" with "beta" in f.txt.`,
      maxOutputTokens: 300, schema: ACTION_SCHEMA,
    });
    const act = parseAction(JSON.parse(b.content));
    if (act.kind === "edit") applyEdits(dir, act.edits, []);
    detail.patch_apply = readFileSync(join(dir, "f.txt"), "utf8") === "beta" ? "pass" : "fail";
  } catch {
    detail.patch_apply = "fail";
  }
  const q: Qualification = {
    profileId: p.id, family: "action-protocol", source: "probe", at: new Date().toISOString(), detail,
    passed: detail.valid_output === "pass" && detail.patch_apply === "pass",
  };
  store.record(q);
  return q;
}

export type Role = "worker" | "architect" | "reviewer";
const FAMILY: Record<Role, Family> = { worker: "action-protocol", architect: "architecture", reviewer: "review" };

// Cheapest-first list; the first profile that is qualified for the role wins. Never "cheapest unqualified".
export function selectProfile(role: Role, tier: RiskTier, candidates: GenerationProvider[], store: QualStore):
  { ok: true; provider: GenerationProvider } | { ok: false; reason: string } {
  if (tier === "R0") return { ok: false, reason: "R0 uses a deterministic recipe: no model" };
  for (const c of candidates) if (store.has(c.id, FAMILY[role])) return { ok: true, provider: c };
  return { ok: false, reason: `unsupported capability: no profile qualified for ${FAMILY[role]}` };
}
