// TypeSafe Jev "Choice" transport: POST /v1/systemone. Used ONLY for bounded decisions among options the
// caller already allowed; it never generates code and its output is never an authority. Every response is
// validated: a well-formed distribution is a statistic, not a measured probability of being right.
export type Question = { instructions: string; criteria: Record<string, string> };
export type ChoiceAnswer = { choice: string; confidence: number; probabilities: Record<string, number> };
export type JevResult = { model: string; answers: Record<string, ChoiceAnswer>; usage: { input: number; output: number } | null; latencyMs: number };
export interface DecisionTransport {
  choice(req: { state: string; questions: Record<string, Question> }): Promise<JevResult>;
}

export class JevInvalid extends Error {
  readonly reason = "provider failure";
}
export class JevUnavailable extends Error {
  readonly reason = "provider failure";
}

export type JevConfig = { apiKey: string | undefined; baseUrl?: string; model?: string; timeoutMs?: number };
export const MAX_OPTIONS = 255; // documented Choice limit

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

// Strict: option membership, completeness, finite ranges, sum ≈ 1, choice = argmax, no unexpected answers.
export function validateChoiceResponse(questions: Record<string, Question>, body: unknown, latencyMs: number): JevResult {
  const b = body as { model?: unknown; answers?: Record<string, any>; usage?: any };
  if (!b || typeof b !== "object" || typeof b.model !== "string" || !b.model) throw new JevInvalid("response.model missing");
  if (!b.answers || typeof b.answers !== "object") throw new JevInvalid("response.answers missing");
  const ids = Object.keys(questions);
  const got = Object.keys(b.answers);
  if (got.length !== ids.length || !ids.every((i) => got.includes(i))) throw new JevInvalid("answers do not match the questions asked");
  const answers: Record<string, ChoiceAnswer> = {};
  for (const id of ids) {
    const a = b.answers[id];
    const options = Object.keys(questions[id]!.criteria);
    if (!a || a.type !== "choice" || typeof a.choice !== "string") throw new JevInvalid(`${id}: not a choice answer`);
    const p = a.probabilities as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object") throw new JevInvalid(`${id}: probabilities missing`);
    const keys = Object.keys(p);
    if (keys.length !== options.length || !options.every((o) => keys.includes(o))) throw new JevInvalid(`${id}: distribution is not exactly the offered options`);
    let sum = 0, best = options[0]!;
    for (const o of options) {
      const v = p[o];
      if (!finite(v) || v < 0 || v > 1) throw new JevInvalid(`${id}: probability for ${o} is not a finite number in [0,1]`);
      sum += v;
      if ((p[o] as number) > (p[best] as number)) best = o;
    }
    if (Math.abs(sum - 1) > 0.02) throw new JevInvalid(`${id}: probabilities sum to ${sum.toFixed(3)}`);
    if (!options.includes(a.choice)) throw new JevInvalid(`${id}: choice "${a.choice}" is not an offered option`);
    if ((p[a.choice] as number) < (p[best] as number) - 1e-9) throw new JevInvalid(`${id}: choice is not the most probable option`);
    if (!finite(a.confidence) || a.confidence < 0 || a.confidence > 1) throw new JevInvalid(`${id}: confidence out of range`);
    answers[id] = { choice: a.choice, confidence: a.confidence, probabilities: p as Record<string, number> };
  }
  const u = b.usage;
  return { model: b.model, answers, usage: finite(u?.input_tokens) && finite(u?.output_tokens) ? { input: u.input_tokens, output: u.output_tokens } : null, latencyMs };
}

export class JevClient implements DecisionTransport {
  #c: JevConfig;
  constructor(config: JevConfig) {
    this.#c = config;
  }
  async choice(req: { state: string; questions: Record<string, Question> }): Promise<JevResult> {
    if (!this.#c.apiKey) throw new JevUnavailable("no Jev credential available to the controller");
    for (const [id, q] of Object.entries(req.questions)) {
      const n = Object.keys(q.criteria).length;
      if (n < 2 || n > MAX_OPTIONS) throw new JevInvalid(`${id}: needs 2..${MAX_OPTIONS} options`);
    }
    const started = Date.now();
    let r: Response;
    try {
      r = await fetch(`${this.#c.baseUrl ?? "https://api.typesafe.ai"}/v1/systemone`, {
        method: "POST",
        signal: AbortSignal.timeout(this.#c.timeoutMs ?? 10_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#c.apiKey}` },
        body: JSON.stringify({
          state: req.state, model: this.#c.model ?? "jev-latest",
          questions: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { type: "choice", instructions: q.instructions, criteria: q.criteria }])),
        }),
      });
    } catch (e) {
      throw new JevUnavailable(`request failed: ${(e as Error).name}`); // timeout / network; never include the key
    }
    if (!r.ok) throw new JevUnavailable(`http ${r.status}`);
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      throw new JevInvalid("response is not JSON");
    }
    return validateChoiceResponse(req.questions, body, Date.now() - started);
  }
}
