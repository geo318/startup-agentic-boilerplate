import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, GenerateResult, GenerationProvider } from "./provider.ts";

export type ClaudeProfile = {
  model: string; // exact id, e.g. claude-haiku-4-5-20251001 — no default alias
  maxBudgetUsd: number; // hard cap passed to the CLI for each call
  timeoutMs: number;
  bin?: string;
};

// Claude Code CLI used as a plain text generator: every tool, skill, MCP server and settings source is off,
// no session is kept, and it runs in an empty directory. The controller stays in charge of all effects.
// HOSTED: prompt content is sent to Anthropic, so drive() requires egress consent.
export class ClaudeCliProvider implements GenerationProvider {
  readonly id: string;
  readonly hosted = true;
  #p: ClaudeProfile;
  constructor(profile: ClaudeProfile) {
    this.#p = profile;
    this.id = `claude-cli/${profile.model}`;
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const args = [
      "-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--disable-slash-commands",
      "--setting-sources", "", "--strict-mcp-config", "--model", this.#p.model,
      "--max-budget-usd", String(this.#p.maxBudgetUsd), "--system-prompt", req.system,
      ...(req.schema ? ["--json-schema", JSON.stringify(req.schema)] : []),
    ];
    const fail = (): GenerateResult => ({ content: "", finishReason: "error", usage: null, latencyMs: Date.now() - started });
    return new Promise((resolve) => {
      let out = "";
      const child = spawn(this.#p.bin ?? "claude", args, {
        cwd: mkdtempSync(join(tmpdir(), "claude-gen-")),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", ...( // USER: macOS keychain lookup needs it
          process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}) },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), this.#p.timeoutMs);
      req.signal?.addEventListener("abort", () => child.kill("SIGKILL"));
      child.stdout.on("data", (b) => (out += b));
      child.on("error", () => resolve(fail()));
      child.on("close", () => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(out);
          if (j.is_error || j.subtype !== "success") return resolve(fail());
          const u = j.usage;
          const usage = u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
            ? { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens }
            : null;
          const content = j.structured_output !== undefined ? JSON.stringify(j.structured_output) : String(j.result ?? "");
          resolve({
            content, finishReason: j.terminal_reason === "completed" ? "stop" : "error", usage, latencyMs: Date.now() - started,
            ...(typeof j.total_cost_usd === "number" ? { costUsd: j.total_cost_usd } : {}),
          });
        } catch {
          resolve(fail());
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(req.prompt);
    });
  }
}
