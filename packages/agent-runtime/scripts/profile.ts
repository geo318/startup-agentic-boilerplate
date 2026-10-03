import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createProvider, modelProject, readModels } from "../src/models.ts";

// Share the runtime's configuration and adapter semantics; never infer a vendor from a model name.
export function selectedProfile(env: NodeJS.ProcessEnv = process.env) {
  const file = resolve(env.MODELS ?? ".agents/models.json");
  const models = readModels(file);
  const name = env.PROFILE ?? models.roles.worker;
  const context = {
    home: env.AGENTIC_HOME ?? join(homedir(), ".agentic"),
    project: modelProject(file),
    out: (message: string) => console.log(message),
  };
  const provider = createProvider(name, models, context);
  if (provider.hosted && env.ALLOW_HOSTED !== "1")
    throw new Error("set ALLOW_HOSTED=1 to allow the selected profile to receive evaluation prompts");
  return { profile: { name, def: models.profiles[name]! }, provider, hosted: provider.hosted };
}
