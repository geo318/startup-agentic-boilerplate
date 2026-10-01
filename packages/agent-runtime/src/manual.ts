import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GenerateRequest, GenerateResult, GenerationProvider } from "./provider.ts";

// Manual packet exchange: works with any agent or chat the user operates (Codex, a web chat, a person).
// generate() writes packet-N.json, then waits for the reply in response-N.txt (raw JSON only).
// Treated as hosted: the controller cannot know where the user pastes the packet, so egress consent applies.
export class ManualProvider implements GenerationProvider {
  readonly id: string;
  readonly hosted = true;
  #dir: string;
  #timeoutMs: number;
  #n = 0;
  constructor(dir: string, label: string, timeoutMs = 600_000) {
    this.#dir = dir;
    this.#timeoutMs = timeoutMs;
    this.id = `manual/${label}`;
    mkdirSync(dir, { recursive: true });
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const n = (this.#n += 1);
    writeFileSync(
      join(this.#dir, `packet-${n}.json`),
      JSON.stringify(
        {
          instructions: `Answer the prompt below and save ONLY the JSON reply to ${join(this.#dir, `response-${n}.txt`)}`,
          system: req.system,
          prompt: req.prompt,
          schema: req.schema ?? null,
          maxOutputTokens: req.maxOutputTokens,
        },
        null,
        2,
      ),
    );
    const reply = join(this.#dir, `response-${n}.txt`);
    while (Date.now() - started < this.#timeoutMs && !req.signal?.aborted) {
      if (existsSync(reply)) {
        const content = readFileSync(reply, "utf8").trim();
        if (content) return { content, finishReason: "stop", usage: null, latencyMs: Date.now() - started };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { content: "", finishReason: "error", usage: null, latencyMs: Date.now() - started };
  }
}
