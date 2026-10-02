import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GenerateRequest, GenerateResult, GenerationProvider } from "./provider.ts";

// Manual packet exchange: works with any agent or chat the user operates (Codex, a web chat, a person).
// Each request gets unique packet/reply paths, including across roles and process restarts.
// Treated as hosted: the controller cannot know where the user pastes the packet, so egress consent applies.
export class ManualProvider implements GenerationProvider {
  readonly id: string;
  readonly hosted = true;
  #dir: string;
  #timeoutMs: number;
  #onPacket: (packet: string, reply: string) => void;
  constructor(
    dir: string,
    label: string,
    timeoutMs = 600_000,
    onPacket = (packet: string, reply: string) => {
      console.log(`handoff packet: ${packet}\nreply with JSON: ${reply}`);
    },
  ) {
    this.#dir = resolve(dir);
    this.#onPacket = onPacket;
    this.#timeoutMs = timeoutMs;
    this.id = `manual/${label}`;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const n = randomUUID();
    const packet = join(this.#dir, `packet-${n}.json`);
    const reply = join(this.#dir, `response-${n}.txt`);
    writeFileSync(
      packet,
      JSON.stringify(
        {
          instructions: `Answer the prompt below and save ONLY the JSON reply to ${reply}`,
          system: req.system,
          prompt: req.prompt,
          schema: req.schema ?? null,
          maxOutputTokens: req.maxOutputTokens,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    this.#onPacket(packet, reply);
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
