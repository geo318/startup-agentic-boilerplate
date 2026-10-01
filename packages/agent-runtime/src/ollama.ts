import { canonical, sha256 } from "./hash.ts";
import type { GenerateRequest, GenerateResult, GenerationProvider } from "./provider.ts";

export type OllamaProfile = {
  baseUrl: string; // e.g. http://127.0.0.1:11434
  model: string; // exact tag; no unconfigured aliases
  numCtx: number; // usable context, measured, not the model's advertised maximum
  temperature: number;
  timeoutMs: number;
};

function isLoopback(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Native /api/chat, non-streaming. Schema-constrained output when a schema is given; the caller still
// validates semantics. Usage comes from the server's own counters, or null if absent.
export class OllamaProvider implements GenerationProvider {
  readonly id: string;
  readonly hosted: boolean; // anything but loopback is off-machine: egress consent applies
  #p: OllamaProfile;
  constructor(profile: OllamaProfile) {
    this.#p = profile;
    this.hosted = !isLoopback(profile.baseUrl);
    this.id = `ollama/${profile.model}@ctx${profile.numCtx}/${sha256(canonical(profile))}`;
  }

  // Cheap doctor probe: server reachable and the exact model is pulled. Never pulls anything.
  async probe(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const r = await fetch(`${this.#p.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { ok: false, reason: `tags http ${r.status}` };
      const body = (await r.json()) as { models?: Array<{ name?: string; model?: string }> };
      const has = body.models?.some((m) => m.name === this.#p.model || m.model === this.#p.model);
      return has ? { ok: true } : { ok: false, reason: `model not pulled: ${this.#p.model}` };
    } catch (e) {
      return { ok: false, reason: `unreachable: ${(e as Error).message}` };
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(this.#p.timeoutMs)])
      : AbortSignal.timeout(this.#p.timeoutMs);
    try {
      const r = await fetch(`${this.#p.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          model: this.#p.model,
          stream: false,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
          ...(req.schema ? { format: req.schema } : {}),
          options: { num_predict: req.maxOutputTokens, num_ctx: this.#p.numCtx, temperature: this.#p.temperature },
        }),
      });
      if (!r.ok) return { content: "", finishReason: "error", usage: null, latencyMs: Date.now() - started };
      const b = (await r.json()) as {
        message?: { content?: unknown };
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const content = typeof b.message?.content === "string" ? b.message.content : "";
      const usage =
        typeof b.prompt_eval_count === "number" && typeof b.eval_count === "number"
          ? { input: b.prompt_eval_count, output: b.eval_count }
          : null;
      // anything but a clean stop (e.g. "length") is non-executable
      return {
        content,
        finishReason: b.done_reason === "stop" ? "stop" : b.done_reason === "length" ? "length" : "error",
        usage,
        latencyMs: Date.now() - started,
      };
    } catch {
      return { content: "", finishReason: "error", usage: null, latencyMs: Date.now() - started };
    }
  }
}
