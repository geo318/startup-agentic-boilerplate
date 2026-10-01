import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ISOLATION_QUESTION = `Run verification inside Docker?

  yes → tests and checks run in a throwaway container: no network, non-root, only the
        workspace mounted. Needs Docker running and an image you configured.
  no  → they run directly on this machine with your user's permissions (no isolation).
        Not allowed for R3 work (auth, tenancy, money, migrations, CI/dependency changes).

Answer yes or no: `;

export type Choice = "docker" | "none";

// Only an explicit yes/no counts. Anything else re-asks, then gives up as "unanswered" (never a default).
export async function askIsolation(ask: (q: string) => Promise<string>, tries = 3): Promise<Choice | undefined> {
  for (let i = 0; i < tries; i++) {
    const a = (await ask(ISOLATION_QUESTION)).trim().toLowerCase();
    if (a === "yes" || a === "y") return "docker";
    if (a === "no" || a === "n") return "none";
  }
  return undefined;
}

// Decision lives in controller state (outside the workspace), per run directory.
export function saveChoice(stateDir: string, choice: Choice): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "isolation-consent.json"),
    JSON.stringify({ isolation: choice, decidedAt: new Date().toISOString() }),
  );
}
export function loadChoice(stateDir: string): Choice | undefined {
  const f = join(stateDir, "isolation-consent.json");
  if (!existsSync(f)) return undefined;
  const v = JSON.parse(readFileSync(f, "utf8")).isolation;
  return v === "docker" || v === "none" ? v : undefined;
}
