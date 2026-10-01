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

// Probes: valid output + a real patch applied to a scratch file, repeated: a single sample is too noisy to qualify a
// model. Each attempt may use one retry with the exact rejection as feedback (what the driver does at run time);
// first-try results are recorded separately. Passing needs EVERY attempt to succeed. Cancellation and context-fit
// are reported as not probed rather than assumed.
export async function probeActionProtocol(p: GenerationProvider, store: QualStore, attempts = 3): Promise<Qualification> {
  const detail: Record<string, string> = { cancellation: "not-probed", context_fit: "not-probed", attempts: String(attempts) };
  const sys = 'Reply with ONE JSON object only. Allowed kinds: finish, edit (edits:[{kind:"replace",path,expectHash,find,replace}]). An edit action has only id, kind and edits.';
  let validOk = 0, patchOk = 0, validFirst = 0, patchFirst = 0;
  const attempt = async (prompt: string, check: (content: string) => boolean): Promise<[boolean, boolean]> => {
    let feedback = "";
    for (let t = 0; t < 2; t++) {
      try {
        const r = await p.generate({ system: sys, prompt: prompt + feedback, maxOutputTokens: 300, schema: ACTION_SCHEMA });
        if (r.finishReason === "stop" && check(r.content)) return [true, t === 0];
        feedback = "\nYour previous reply was rejected as invalid. Reply again with exactly one valid action.";
      } catch (e) {
        feedback = `\nYour previous reply was rejected: ${(e as Error).message}. Reply again with exactly one valid action.`;
      }
    }
    return [false, false];
  };
  for (let i = 0; i < attempts; i++) {
    const [v, vf] = await attempt('Reply with the finish action: {"id":"p1","kind":"finish"}', (c) => parseAction(JSON.parse(c)).kind === "finish");
    validOk += v ? 1 : 0; validFirst += vf ? 1 : 0;
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    writeFileSync(join(dir, "f.txt"), "alpha");
    const [pa, pf] = await attempt(
      `File f.txt (hash ${sha256("alpha")}) contains: alpha\nReply with one edit action replacing "alpha" with "beta" in f.txt.`,
      (c) => { const act = parseAction(JSON.parse(c)); if (act.kind === "edit") applyEdits(dir, act.edits, []); return readFileSync(join(dir, "f.txt"), "utf8") === "beta"; },
    );
    patchOk += pa ? 1 : 0; patchFirst += pf ? 1 : 0;
  }
  detail.valid_output = `${validOk}/${attempts}`;
  detail.patch_apply = `${patchOk}/${attempts}`;
  detail.first_try = `${validFirst + patchFirst}/${attempts * 2}`;
  const q: Qualification = { profileId: p.id, family: "action-protocol", source: "probe", at: new Date().toISOString(), detail, passed: validOk === attempts && patchOk === attempts };
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
