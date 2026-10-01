export type Usage = { input: number; output: number } | null; // null = provider reported nothing (unknown, not zero)
export type GenerateRequest = { system: string; prompt: string; maxOutputTokens: number };
export type GenerateResult = {
  content: string;
  finishReason: "stop" | "length" | "error";
  usage: Usage;
  latencyMs: number;
};
export interface GenerationProvider {
  readonly id: string; // exact model/profile identity, never a bare alias
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

// Deterministic replay for engine tests. Proves the controller, not any model's coding ability.
export class MockProvider implements GenerationProvider {
  readonly id = "mock/replay";
  calls: GenerateRequest[] = [];
  #script: Array<string | Partial<GenerateResult>>;
  constructor(script: Array<string | Partial<GenerateResult>>) {
    this.#script = [...script];
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const next = this.#script.shift();
    if (next === undefined) return { content: "", finishReason: "error", usage: null, latencyMs: 0 };
    const r = typeof next === "string" ? { content: next } : next;
    return { content: "", finishReason: "stop", usage: { input: 0, output: 0 }, latencyMs: 0, ...r };
  }
}
