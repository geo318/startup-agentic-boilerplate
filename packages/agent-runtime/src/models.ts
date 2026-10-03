import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatCompletionsProvider } from "./chat.ts";
import { ClaudeCliProvider } from "./claude.ts";
import { ManualProvider } from "./manual.ts";
import { OllamaProvider } from "./ollama.ts";
import { type GenerationProvider, MockProvider } from "./provider.ts";
import { sha256 } from "./hash.ts";
import { validate } from "./schema.ts";

export type ProviderContext = { home: string; project: string; out: (message: string) => void };

export type Models = {
  execution?: "handoff" | "delegated";
  profiles: Record<string, Record<string, any>>;
  roles: { worker: string; workerStrong?: string; architect?: string; reviewer?: string };
};

// Keep adapters and provider construction on the same controller-owned path.
export const handoffDirectory = (env: ProviderContext): string =>
  join(resolve(env.home), "exchange", sha256(resolve(env.project)).slice(0, 16));

export function createProvider(name: string, models: Models, env?: ProviderContext): GenerationProvider {
  const errors = validate(modelSchema, { schemaVersion: 1, ...models });
  if (errors.length) throw new Error(`invalid model configuration: ${errors.join("; ")}`);
  const p = models.profiles[name];
  if (!p) throw new Error(`profile not defined: ${name}`);
  if (p.kind !== "manual" && p.kind !== "replay" && models.execution !== "delegated")
    throw new Error(
      `profile "${name}" (${p.kind}/${p.model}) requires execution: delegated. The chat model is not inherited. Run the runtime upgrade command with --execution handoff or --execution delegated; see docs/migration-guide.md.`,
    );
  switch (p.kind) {
    case "claude-cli":
      return new ClaudeCliProvider({
        model: p.model,
        maxBudgetUsd: p.maxBudgetUsd ?? 0.05,
        timeoutMs: p.timeoutMs ?? 120_000,
      });
    case "ollama":
      return new OllamaProvider({
        baseUrl: p.baseUrl,
        model: p.model,
        numCtx: p.numCtx ?? 4096,
        temperature: 0,
        timeoutMs: p.timeoutMs ?? 120_000,
      });
    case "chat-completions":
      return new ChatCompletionsProvider({
        baseUrl: p.baseUrl,
        model: p.model,
        hosted: p.hosted,
        apiKeyEnv: p.apiKeyEnv,
        supportsJsonSchema: p.supportsJsonSchema ?? false,
        temperature: 0,
        timeoutMs: p.timeoutMs ?? 120_000,
      });
    case "manual":
      return new ManualProvider(
        env ? handoffDirectory(env) : p.dir,
        p.label,
        p.timeoutMs,
        env
          ? (packet, reply) =>
              env.out(
                `handoff ${name}: packet ${packet}\nSave ONLY JSON to ${reply}; leave the controller running. Reviewer packets need a separate review context.`,
              )
          : undefined,
      );
    case "replay":
      return Object.assign(
        new MockProvider(JSON.parse(readFileSync(resolve(env?.project ?? process.cwd(), p.file), "utf8"))),
        {
          id: `mock/replay:${basename(p.file)}`,
        },
      );
  }
  throw new Error(`unsupported profile kind: ${p.kind}`);
}

const modelSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../schemas/models.schema.json", import.meta.url)), "utf8"),
);

export function modelProject(file: string): string {
  const directory = dirname(resolve(file));
  return basename(directory) === ".agents" ? dirname(directory) : directory;
}

export function readModels(file: string): Models {
  const models = JSON.parse(readFileSync(file, "utf8"));
  const errors = validate(modelSchema, models);
  if (errors.length) throw new Error(`invalid model configuration ${file}: ${errors.join("; ")}`);
  // File-backed profiles resolve from the consumer project, not the caller's current directory.
  const project = modelProject(file);
  for (const p of Object.values((models as Models).profiles)) {
    if (p.kind === "replay") p.file = resolve(project, p.file);
    if (p.kind === "manual") p.dir = resolve(project, p.dir);
  }
  return models;
}
