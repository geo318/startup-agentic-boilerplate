# Token tools and the post-setup audit

Used at step 1 (check), step 7 (recommend), and step 9 (audit) — in every mode (new, adopt,
upgrade). These are machine-level tools, not project dependencies: recommend, never install
without the user's yes, and never add them to the project's `package.json`.

## Check and recommend

`detect.mjs` returns `tokenTools: { rtk, headroom, ponytail }` (booleans). For each `false`, show
the line below once, in the step 3 summary, and let the user pick. Skipping is fine; record the
choice in `context/progress-tracker.md` so it is not asked again.

| Tool | What it saves | Install |
| --- | --- | --- |
| rtk | Condenses shell command output (git, tests, builds) before it reaches the model | Install per its README (`rtk-ai/rtk` on GitHub: release binary or package manager), then `rtk init -g` (adds the Claude Code hook) |
| headroom | Compresses context and tool results through a local proxy | `uv tool install --python 3.13 "headroom-ai[all]"`, then launch sessions with `headroom wrap claude`; or `/plugin marketplace add chopratejas/headroom` then `/plugin install headroom@headroom-marketplace` |
| ponytail | Shorter, smaller diffs and replies (lazy-senior coding mode) | `/plugin marketplace add DietrichGebert/ponytail`, then in a second prompt `/plugin install ponytail@ponytail` |

Confirm the commands against each project's README before running them (`rtk init --help`,
`headroom --help`): they change between releases. The plugin commands are slash commands the user
types; you cannot run them.

## Relay to subagents

Subagents start with a fresh context and do not inherit what the user installed. When the user
accepts or already has a tool:

- `AGENTS.md` carries one line (template: "Token tools" section) so every agent and subagent
  reads it. Fill it with the tools actually present, e.g. "Run shell commands as normal: rtk
  condenses their output. Keep diffs minimal (ponytail)."
- When spawning a subagent, put the same line in its prompt, and tell it to ask for a re-run as
  `rtk proxy <cmd>` only when output looks unusable.
- A tool that is not installed is not mentioned in `AGENTS.md`.

## Post-setup audit

After step 8 passes, run:

```bash
node <skill-dir>/scripts/token-audit.mjs --target <target>
rtk gain   # if rtk is installed: measured savings so far
```

Then, in the final report, give at most five suggestions, ordered by tokens saved, each naming
the exact file or setting. Look for:

| Signal in the JSON | Suggest |
| --- | --- |
| `mcpServers.unused` non-empty | Remove or disable the server (`claude mcp remove <name>`); its tool schemas load every session |
| `mcpServers.configured` > 3 | Keep the ones used; move the rest to project-scoped `.mcp.json` so other repos do not pay |
| `skills.unused` with large `tokens` | Delete or move to a project that uses it; shorten a description over ~60 tokens |
| `instructionFiles` over ~2,000 tokens each | Move topic prose into `context/` and link it (`AGENTS.md` stays under 200 lines) |
| `enabledPlugins` unused | `/plugin` → disable; each ships hooks, skills, and commands |
| An unused tool from the table above | Recommend it (one line) |
| `sessionsScanned` is 0 | Say usage is unknown; judge from configuration only |

General habits worth one line if relevant: `/clear` between unrelated jobs, `/context` to see
live usage, a cheaper model for mechanical subagents. Never suggest `/compact` as a saving.

Report findings only; change nothing unasked. A server or skill with no calls in 40 sessions may
still be needed rarely — say "unused in the last N sessions", not "unneeded".
