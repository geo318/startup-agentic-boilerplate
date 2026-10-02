export type Usage = { input: number; output: number } | null; // null = provider reported nothing (unknown, not zero)
export type GenerateRequest = {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  maxCostUsd?: number; // provider-enforced per-call cap, when supported
  schema?: object;
  signal?: AbortSignal;
};
export type GenerateResult = {
  content: string;
  finishReason: "stop" | "length" | "error";
  usage: Usage;
  latencyMs: number;
  costUsd?: number; // hosted spend as reported by the provider; absent = unknown
};
export interface GenerationProvider {
  readonly id: string; // exact model/profile identity, never a bare alias
  readonly supportsCostLimit?: boolean;
  readonly hosted: boolean; // true = prompt content leaves this machine
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

// Deterministic replay for engine tests. Proves the controller, not any model's coding ability.
export class MockProvider implements GenerationProvider {
  readonly id = "mock/replay";
  readonly hosted = false;
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

// Shared by qualification and task calls. Unknown billing stops further hosted calls.
// ponytail: callers run serially; reserve in-flight dollars before introducing parallel calls.
export type Spend = {
  limitUsd: number;
  costUsd: number;
  calls: number;
  tokens: number;
  unknownCostCalls: number;
  unknownUsageCalls: number;
};
export function budgetProvider(
  p: GenerationProvider,
  spend: Spend,
  updated: () => void = () => {},
): GenerationProvider {
  return {
    id: p.id,
    hosted: p.hosted,
    supportsCostLimit: p.supportsCostLimit,
    async generate(req) {
      if (
        !Number.isFinite(spend.limitUsd) ||
        spend.limitUsd <= 0 ||
        !Number.isFinite(spend.costUsd) ||
        spend.costUsd < 0 ||
        (req.maxCostUsd !== undefined && (!Number.isFinite(req.maxCostUsd) || req.maxCostUsd <= 0))
      )
        throw new Error("spending stopped: invalid budget or reported cost");
      const remaining = spend.limitUsd - spend.costUsd;
      if (p.hosted && (!p.supportsCostLimit || spend.unknownCostCalls || remaining <= 0))
        throw new Error("spending stopped: budget exhausted, unknown billing, or provider cannot cap a call");
      spend.calls++;
      let r: GenerateResult;
      try {
        r = await p.generate({
          ...req,
          ...(p.hosted ? { maxCostUsd: Math.min(remaining, req.maxCostUsd ?? Infinity) } : {}),
        });
      } catch (e) {
        if (p.hosted) spend.unknownCostCalls++;
        spend.unknownUsageCalls++;
        updated();
        throw e;
      }
      if (r.usage && Number.isFinite(r.usage.input + r.usage.output) && r.usage.input >= 0 && r.usage.output >= 0)
        spend.tokens += r.usage.input + r.usage.output;
      else spend.unknownUsageCalls++;
      if (typeof r.costUsd === "number" && Number.isFinite(r.costUsd) && r.costUsd >= 0) spend.costUsd += r.costUsd;
      else if (p.hosted) spend.unknownCostCalls++;
      updated();
      return r;
    },
  };
}
