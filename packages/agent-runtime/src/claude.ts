import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, GenerateResult, GenerationProvider } from "./provider.ts";

export type ClaudeProfile = {
  model: string; // exact id, e.g. claude-haiku-4-5-20251001 — no default alias
  maxBudgetUsd: number; // requested CLI cap per call; provider billing may overshoot in flight
  timeoutMs: number;
  bin?: string;
};

// Claude Code CLI used as a plain text generator: every tool, skill, MCP server and settings source is off,
// no session is kept, and it runs in an empty directory. The controller stays in charge of all effects.
// HOSTED: prompt content is sent to Anthropic, so drive() requires egress consent.
export class ClaudeCliProvider implements GenerationProvider {
  readonly id: string;
  readonly hosted = true;
  readonly supportsCostLimit = true;
  #p: ClaudeProfile;
  constructor(profile: ClaudeProfile) {
    if (!Number.isFinite(profile.maxBudgetUsd) || profile.maxBudgetUsd <= 0)
      throw new Error("Claude requires a positive finite dollar cap");
    this.#p = profile;
    this.id = `claude-cli/${profile.model}`;
  }

  generate(req: GenerateRequest): Promise<GenerateResult> {
    if (req.maxCostUsd !== undefined && (!Number.isFinite(req.maxCostUsd) || req.maxCostUsd <= 0))
      throw new Error("Claude requires a positive finite dollar cap");
    const started = Date.now();
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--model",
      this.#p.model,
      "--max-budget-usd",
      String(Math.min(this.#p.maxBudgetUsd, req.maxCostUsd ?? Infinity)),
      "--system-prompt",
      req.system,
      ...(req.schema ? ["--json-schema", JSON.stringify(req.schema)] : []),
    ];
    const fail = (): GenerateResult => ({
      content: "",
      finishReason: "error",
      usage: null,
      latencyMs: Date.now() - started,
    });
    return new Promise((resolve) => {
      let out = "";
      const cwd = mkdtempSync(join(tmpdir(), "claude-gen-"));
      const child = spawn(this.#p.bin ?? "claude", args, {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          USER: process.env.USER ?? "",
          ...// USER: macOS keychain lookup needs it
          (process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), this.#p.timeoutMs);
      req.signal?.addEventListener("abort", () => child.kill("SIGKILL"));
      child.stdout.on("data", (b) => (out += b));
      child.on("error", () => resolve(fail()));
      child.on("close", () => {
        clearTimeout(timer);
        rmSync(cwd, { recursive: true, force: true });
        try {
          const j = JSON.parse(out);
          const ok = !j.is_error && j.subtype === "success" && j.terminal_reason === "completed";
          const u = j.usage;
          const usage =
            u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number"
              ? {
                  input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
                  output: u.output_tokens,
                }
              : null;
          const content =
            j.structured_output !== undefined ? JSON.stringify(j.structured_output) : String(j.result ?? "");
          resolve({
            content: ok ? content : "",
            finishReason: ok ? "stop" : "error",
            usage,
            latencyMs: Date.now() - started,
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
