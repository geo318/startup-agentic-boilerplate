import type { GenerateRequest, GenerateResult, GenerationProvider } from "./provider.ts";

// One heavy local inference at a time. Share one Serial across every local role (worker, architect, reviewer).
export class Serial {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
  }
}

export function serialized(p: GenerationProvider, lock: Serial): GenerationProvider {
  return { id: p.id, hosted: p.hosted, generate: (req: GenerateRequest): Promise<GenerateResult> => lock.run(() => p.generate(req)) };
}
