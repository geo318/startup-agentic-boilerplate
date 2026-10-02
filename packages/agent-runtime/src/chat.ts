import { canonical, sha256 } from "./hash.ts";
import type { GenerateRequest, GenerateResult, GenerationProvider } from "./provider.ts";

export type ChatProfile = {
  baseUrl: string; // includes the version prefix, e.g. https://host/v1
  model: string;
  hosted: boolean; // the owner declares whether the endpoint is off-machine
  apiKeyEnv?: string; // NAME of an env var read by the controller; the key never enters prompts or config
  supportsJsonSchema: boolean; // "compatible" endpoints differ: unsupported controls are explicit, not assumed
  temperature: number;
  timeoutMs: number;
};

// Chat-completions-compatible transport. Same wire format ≠ same semantics: usage, schema and cancellation
// support are declared per profile and the output is always validated by the caller.
export class ChatCompletionsProvider implements GenerationProvider {
  readonly id: string;
  readonly hosted: boolean;
  #p: ChatProfile;
  constructor(profile: ChatProfile) {
    this.#p = profile;
    this.hosted = profile.hosted;
    this.id = `chat/${profile.model}@${new URL(profile.baseUrl).host}/${sha256(canonical(profile))}`;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const key = this.#p.apiKeyEnv ? process.env[this.#p.apiKeyEnv] : undefined;
    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(this.#p.timeoutMs)])
      : AbortSignal.timeout(this.#p.timeoutMs);
    const fail = (): GenerateResult => ({
      content: "",
      finishReason: "error",
      usage: null,
      latencyMs: Date.now() - started,
    });
    try {
      const r = await fetch(`${this.#p.baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: this.#p.model,
          temperature: this.#p.temperature,
          max_tokens: req.maxOutputTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
          ...(req.schema && this.#p.supportsJsonSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: "action", schema: req.schema },
                },
              }
            : {}),
        }),
      });
      if (!r.ok) return fail();
      const b = (await r.json()) as {
        choices?: Array<{
          message?: { content?: unknown };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const c = b.choices?.[0];
      const content = typeof c?.message?.content === "string" ? c.message.content : "";
      const u = b.usage;
      const usage =
        typeof u?.prompt_tokens === "number" && typeof u?.completion_tokens === "number"
          ? { input: u.prompt_tokens, output: u.completion_tokens }
          : null;
      return {
        content,
        finishReason: c?.finish_reason === "stop" ? "stop" : c?.finish_reason === "length" ? "length" : "error",
        usage,
        latencyMs: Date.now() - started,
      };
    } catch {
      return fail();
    }
  }
}
