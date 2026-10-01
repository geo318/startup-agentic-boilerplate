// One ledger per task. Children share the same object, so subdividing never resets limits.
export type Limits = { aggregateTokens: number; toolActions: number; semanticRepairs: number };

export class BudgetExceeded extends Error {
  readonly reason = "budget exhausted";
}

export class Ledger {
  tokens = 0;
  actions = 0;
  repairs = 0;
  unknownUsageCalls = 0; // unknown usage is unknown, not zero
  readonly limits: Limits;
  constructor(limits: Limits) {
    this.limits = limits;
  }
  // Reserve the worst case before a call; settle() corrects to actual usage when known.
  reserve(maxTokens: number): number {
    if (this.tokens + maxTokens > this.limits.aggregateTokens) throw new BudgetExceeded("tokens");
    this.tokens += maxTokens;
    return maxTokens;
  }
  settle(reserved: number, actual: number | null): void {
    if (actual === null) this.unknownUsageCalls += 1; // keep the reservation: assume worst case
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
