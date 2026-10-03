// One ledger per task. Children share the same object, so subdividing never resets limits.
export type Limits = { aggregateTokens?: number; toolActions: number; semanticRepairs: number };

export class BudgetExceeded extends Error {
  readonly reason = "budget exhausted";
}

export class Ledger {
  tokens = 0;
  actions = 0;
  repairs = 0;
  costUsd = 0; // reported spend only
  unknownCostCalls = 0;
  unknownUsageCalls = 0; // unknown usage is unknown, not zero
  readonly limits: Limits;
  constructor(limits: Limits) {
    this.limits = limits;
  }
  snapshot() {
    return {
      tokens: this.tokens,
      actions: this.actions,
      repairs: this.repairs,
      costUsd: this.costUsd,
      unknownUsageCalls: this.unknownUsageCalls,
      unknownCostCalls: this.unknownCostCalls,
    };
  }
  restore(x: Omit<ReturnType<Ledger["snapshot"]>, "unknownCostCalls"> & { unknownCostCalls?: number }): void {
    Object.assign(this, x);
  }
  // Reserve an estimate before a call (provider overhead can exceed it); settle() corrects to actual usage when known.
  reserve(maxTokens: number): number {
    if (this.limits.aggregateTokens !== undefined && this.tokens + maxTokens > this.limits.aggregateTokens)
      throw new BudgetExceeded("tokens");
    this.tokens += maxTokens;
    return maxTokens;
  }
  settle(reserved: number, actual: number | null, costUsd?: number, hosted = false): void {
    if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) this.costUsd += costUsd;
    else if (hosted) this.unknownCostCalls++;
    if (actual !== null && (!Number.isFinite(actual) || actual < 0)) actual = null;
    if (actual === null)
      this.unknownUsageCalls += 1; // retain the estimate; actual usage is unknown
    else this.tokens += actual - reserved;
  }
  action(): void {
    if (this.actions + 1 > this.limits.toolActions) throw new BudgetExceeded("tool actions");
    this.actions += 1;
  }
  repair(): void {
    if (this.repairs + 1 > this.limits.semanticRepairs) throw new BudgetExceeded("semantic repairs");
    this.repairs += 1;
  }
}
