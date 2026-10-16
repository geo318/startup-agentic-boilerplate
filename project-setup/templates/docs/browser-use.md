# Browser windows and tabs

These rules are mandatory for every agent, especially Codex, including delegated agents and
browser automation used for research, development, and verification.

- Reuse the active browser window and existing task tabs. Never create a new window, browser
  session, profile, or isolated browser instance for each task, tool call, or verification run.
- Open additional tabs only in that same window. Keep all tabs for the task in one clearly
  named tab group; reuse that group throughout the task and on follow-up turns.
- Inspect existing windows, tabs, and groups before opening anything. Attach browser
  automation to the existing browser instead of launching another instance.
- If no browser window exists, open one and reuse it. Otherwise, a separate window or browser
  instance requires an explicit user request. If a tool cannot reuse the window or group tabs,
  use another supported method or report the limitation; never silently open another window.
- Preserve unrelated user tabs, groups, and windows.
