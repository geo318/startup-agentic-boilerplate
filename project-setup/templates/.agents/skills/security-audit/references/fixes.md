# Fixing what the audit found

Each rule below comes from a fix that would otherwise have broken a release or a page.

## Before changing anything

- **Search for what depends on it.** Before removing or gating a route, header or setting, search
  the release scripts, smoke checks, CI and tests for it. A release check may read the very
  schema route you are about to turn off: hide it at the public edge and keep it for the check.
- **Guard where only the affected process is checked.** A setting shared by the API, workers and
  scheduled jobs is loaded by all of them. Require a web-only secret in the release preflight for
  the web tier, not in the shared settings, or the worker fails to start.
- **Check hosted state read-only first.** The secret you are about to require may already be set.

## Request bounds

- A model that validates requests often also reads stored rows. Set a limit at or above what any
  producer writes; a limit that is too tight breaks reads of existing data.
- Check the generated schema after the change. A named type alias can appear as a new named type
  in the client; use a plain alias when the client should keep seeing a string.
- Bound the runs of a costly regex (`[^()]{0,200}`) and time it before and after.

## Response headers

Send on every route from static config: a framing limit (`frame-ancestors`, `X-Frame-Options`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Strict-Transport-Security` and a
`Permissions-Policy` for what the app never uses. Use `'self'` for framing when the app frames
its own files (a PDF preview).

## Script policy

- A nonce needs a page rendered per request. Give the nonce policy to the area that already
  renders per request (the signed-in area) and leave prerendered public pages prerendered.
- The policy belongs to the document. Enter the protected area from a prerendered page by a full
  page load (`<a href>`, `window.location`), never a client navigation, or the page keeps the
  outer page's policy.
- Allow a constant inline script by its hash, computed from the same constant the page renders.
- `'strict-dynamic'` lets scripts loaded by a trusted script run, which covers page chunks and
  third-party widgets without a host allowlist. Add `https:` only as the fallback old browsers
  read. Allow `'unsafe-eval'` in development only.
- Do not add `form-action`, `connect-src` or `frame-src` without exercising payments, uploads and
  embedded frames: checkout widgets post forms to banks and load frames from other origins.
- Before restricting a third-party widget, read its bundle for `eval`, `new Function`, inline
  handlers, `javascript:` links, frames and form posts.
- Verify on a production build: the protected routes send the policy; every `<script>` and script
  preload carries the nonce; the hashed script's hash equals the header's; the public pages are
  still prerendered. Then load the area in a browser and watch the console. If no browser run
  was possible, say so in the pull request and keep `do-not-merge` on.

## Exposed surface

Serve interactive API docs in development only. They load third-party scripts on the same origin
as the session.

## Dependencies

Raise each vulnerable package to its fixed version and nothing else
(`uv lock --upgrade-package name==x.y.z`, `pnpm update name@x.y.z`). Re-run the audit and the
tests, then build the release images: a locked install fails on a lockfile that no longer
matches.

## Before the pull request

Run the checks the pull request's CI will run, the database-backed ones included, and build the
release images when dependencies or the build changed. List every check with its result and
every check that was not run.
