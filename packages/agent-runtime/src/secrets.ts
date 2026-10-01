import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// User-level secret store: $AGENTIC_HOME/secrets.env (KEY=VALUE lines). Read only by the controller; keys are
// handed to provider clients in-process and never enter prompts, task state, telemetry, or worker environments.
// A file readable by group/other is refused rather than used.
export function loadSecrets(home: string): Record<string, string> {
  const file = join(home, "secrets.env");
  if (!existsSync(file)) return {};
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`${file} must not be readable by group/other (chmod 600)`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}
