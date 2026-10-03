import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { createProvider, readModels, type Models } from "../src/models.ts";
import { selectedProfile } from "../scripts/profile.ts";
import { runSuite } from "../src/eval.ts";
import { fileURLToPath } from "node:url";

const config = (def: Record<string, unknown>): Models => ({
  execution: "delegated",
  profiles: { chosen: def },
  roles: { worker: "chosen" },
});

test("provider selection follows the configured adapter, never model-name prefixes", () => {
  const chat = createProvider(
    "chosen",
    config({
      kind: "chat-completions",
      model: "any-vendor/model-v9",
      baseUrl: "http://127.0.0.1:9999/v1",
      hosted: false,
    }),
  );
  assert.match(chat.id, /^chat\/any-vendor\/model-v9@/);
  assert.equal(chat.hosted, false);
  const ollama = createProvider(
    "chosen",
    config({ kind: "ollama", model: "a-different-family:tag", baseUrl: "http://127.0.0.1:11434" }),
  );
  assert.match(ollama.id, /^ollama\/a-different-family:tag@/);
  assert.equal(ollama.hosted, false);
  const remote = createProvider(
    "chosen",
    config({ kind: "ollama", model: "same-model", baseUrl: "https://remote.example" }),
  );
  assert.equal(remote.hosted, true);
  const other = createProvider(
    "chosen",
    config({ kind: "chat-completions", model: "another-model", baseUrl: "http://127.0.0.1:9999/v1", hosted: false }),
  );
  assert.notEqual(chat.id, other.id); // Qualifications cannot survive a model change.
});

test("script profiles preserve execution consent, use the selected role, and reject invalid profiles before calls", (t) => {
  const root = mkdtempSync(join(tmpdir(), "model-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agents"));
  const file = join(root, ".agents/models.json");
  writeFileSync(join(root, "replies.json"), "[]");
  const models = { schemaVersion: 1, ...config({ kind: "replay", file: "replies.json" }) };
  writeFileSync(file, JSON.stringify(models));
  assert.equal(readModels(file).profiles.chosen!.file, join(root, "replies.json"));
  assert.equal(selectedProfile({ MODELS: file }).profile.name, "chosen");
  assert.throws(() => selectedProfile({ MODELS: file, PROFILE: "missing" }), /profile not defined/);
  models.profiles.chosen = {
    kind: "chat-completions",
    model: "chosen-model",
    baseUrl: "https://example.invalid/v1",
    hosted: true,
  };
  writeFileSync(file, JSON.stringify(models));
  assert.throws(() => selectedProfile({ MODELS: file }), /ALLOW_HOSTED/);
  assert.equal(selectedProfile({ MODELS: file, ALLOW_HOSTED: "1" }).provider.hosted, true);
  writeFileSync(file, JSON.stringify({ ...models, execution: "handoff" }));
  assert.throws(() => selectedProfile({ MODELS: file, ALLOW_HOSTED: "1" }), /requires execution: delegated/);
  assert.throws(
    () => createProvider("chosen", config({ kind: "chat-completions", model: "x" })),
    /invalid model configuration/,
  );
});

test("evaluation runs a configured local chat endpoint through qualification and tasks without Claude", async (t) => {
  const requestedModels: string[] = [];
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const request = JSON.parse(data);
    requestedModels.push(request.model);
    const prompt = request.messages[1].content as string;
    const action = prompt.includes("File f.txt")
      ? {
          id: "probe",
          kind: "edit",
          edits: [
            {
              kind: "replace",
              path: "f.txt",
              expectHash: prompt.match(/hash ([a-f0-9]+)/)![1],
              find: "alpha",
              replace: "beta",
            },
          ],
        }
      : prompt.includes("Reply with the finish action")
        ? { id: "probe", kind: "finish" }
        : { id: "stop", kind: "blocked", reason: "synthetic fixture" };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(action) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  const results = await runSuite({
    evalsRoot: fileURLToPath(new URL("../../../evals", import.meta.url)),
    suite: "dev-r1",
    trials: 1,
    budgetUsd: 1,
    hosted: false,
    profile: {
      name: "local-model",
      def: {
        kind: "chat-completions",
        model: "arbitrary-model-v7",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        hosted: false,
      },
    },
  });
  assert.equal(results.length, 8);
  assert(requestedModels.length > 6); // The six qualification calls and subsequent task calls use the same configured model.
  assert(requestedModels.every((m) => m === "arbitrary-model-v7"));
  assert.equal(
    results.reduce((n, r) => n + r.tokens, 0),
    requestedModels.length * 15,
  );
  assert(results.every((r) => r.unknownCostCalls === 0));
});

test("hosted profiles without dollar-cap support fail before inference, not by vendor name", async () => {
  await assert.rejects(
    runSuite({
      evalsRoot: fileURLToPath(new URL("../../../evals", import.meta.url)),
      suite: "dev-r1",
      trials: 1,
      budgetUsd: 1,
      hosted: true,
      profile: {
        name: "hosted-model",
        def: {
          kind: "chat-completions",
          model: "arbitrary-model",
          baseUrl: "https://example.invalid/v1",
          hosted: true,
        },
      },
    }),
    /supports per-call cost limits/,
  );
});
