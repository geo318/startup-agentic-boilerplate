#!/usr/bin/env node
// Shared lifecycle adapter. Hook stdout is reserved for the harness protocol.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { context, keyOf, load, sessionFor, touch, update } from "./state.mjs";
import { finish, sweep } from "./runtime.mjs";

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

async function main() {
  const harness = process.argv[2];
  if (!["claude", "codex"].includes(harness)) throw new Error("unknown-hook-harness");
  const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (typeof payload.session_id !== "string" || !payload.session_id) throw new Error("missing-hook-session-id");
  const ctx = context((harness === "claude" ? process.env.CLAUDE_PROJECT_DIR : null) || payload.cwd || process.cwd());
  const event = payload.hook_event_name;
  const options = { session: payload.session_id, turn: payload.turn_id };
  if (event === "SessionEnd" || event === "Interrupt" || event === "StopFailure") {
    // Persist the release request within short native callback deadlines. The supervisor does
    // the waiting/escalation; a future entry recovers it if that supervisor has also died.
    await finish(ctx, options, { wait: false });
    return;
  }
  if (event === "Stop") {
    const session = load(ctx).sessions[keyOf(options.session)];
    if (session && options.turn && options.turn !== session.turn) return;
    const checks = spawnSync(process.execPath, [join(ctx.root, "scripts/checks/agent-stop.mjs")], {
      cwd: session?.checkout || ctx.root, input: JSON.stringify(payload), encoding: "utf8", timeout: 45000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: session?.checkout || ctx.root },
    });
    if (checks.status !== 0) {
      console.log(JSON.stringify({ decision: "block", reason: checks.error ? "Completion checks could not run; inspect the check script before finishing." : checks.stderr.trim().slice(0, 6000) || "Completion checks failed." }));
      return;
    }
    const result = await finish(ctx, options);
    if (result.code === "cleanup-incomplete") console.log(JSON.stringify({ systemMessage: "Session cleanup is incomplete; inspect .agents/sessions.md. Remaining resources were preserved for recovery." }));
    return;
  }
  if (event === "SessionStart") await sweep(ctx);
  const session = await update(ctx, (state) => {
    const item = sessionFor(state, options.session, ctx.root, options.turn, payload.source || "startup");
    if (event === "SessionStart" && payload.source) item.source = payload.source;
    if (event === "SessionStart" || event === "UserPromptSubmit") {
      if (!item.active || (options.turn && options.turn !== item.turn)) item.needsBegin = true;
      touch(state, item, options.turn || (item.active ? item.turn : randomUUID()));
    } else if (event === "PreToolUse" || event === "PostToolUse") {
      if (options.turn && options.turn !== item.turn) return { ...item, stale: true };
      touch(state, item, options.turn);
    }
    return { ...item };
  });
  if (session.stale) return;
  const command = `{{RUNTIME}} scripts/session/cli.mjs begin --session ${quote(options.session)} --turn ${quote(session.turn)} --intent ${session.source === "startup" ? "fresh" : "continue --reason 'resuming existing context'"}`;
  const instruction = `Session lifecycle: ${command}. Read the current request first; use continue --reason for explicit branch/PR/unfinished-work context. Use the returned checkout and IDs for managed run/finish commands. Follow docs/session-lifecycle.md. Do not ask for routine lifecycle confirmation.`;
  if (event === "SessionStart" || event === "UserPromptSubmit") {
    if (!session.initialized || session.needsBegin) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: instruction } }));
  }
  if (event === "PreToolUse" && (!session.initialized || session.needsBegin)) {
    const tool = payload.tool_name;
    const text = payload.tool_input?.command || "";
    const lifecycle = /^(?:rtk\s+)?(?:node|bun)\s+(?:[^\s]*scripts\/session\/cli\.mjs|"[^"\n]*scripts\/session\/cli\.mjs"|'[^'\n]*scripts\/session\/cli\.mjs')\s+(?:begin|status|sweep|finish)\b/.test(text);
    const preflight = /^(?:rtk\s+)?(?:git\s+(?:status|diff|log|rev-parse|branch|worktree\s+list)\b|(?:cat|rg|sed)\s)/.test(text) && !/[;&|`\n]|\$\(/.test(text);
    if ((tool === "Bash" && !lifecycle && !preflight) || ["apply_patch", "Edit", "Write"].includes(tool)) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: instruction } }));
    }
  }
}

main().catch((error) => { console.error(`session hook: ${error.message}`); process.exitCode = 1; });
