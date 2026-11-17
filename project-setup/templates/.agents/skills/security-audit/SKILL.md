---
name: security-audit
description: Audit how the app handles untrusted input and what it exposes - SQL and HTML injection, request validation, uploads, AI output, outbound fetches, sessions and CSRF, response headers and script policy, exposed development surface, production config guards, regex cost and dependency advisories. Produces a checklist with evidence, then findings by severity; fixes nothing unless asked. Use before a release, after adding an input, upload, AI output or outbound fetch, or when asked whether the app is safe.
---

# Security audit

A checklist first, then a diagnosis: every row ends in pass, fail or not covered, with the
evidence that decided it. This skill reports; the developer decides what to fix. Read
[fixes](references/fixes.md) only when asked to fix.

## 1. Map the surface before judging it

- Read the project's own rules first: the `AGENTS.md` invariants and, when it exists,
  `context/architecture/security.md`. They say where each boundary is meant to be enforced.
- List where untrusted data enters: request bodies and query strings, uploads, webhooks and
  callbacks, pages and files the app fetches, model output.
- List where it lands: SQL, HTML, links and redirects, file names and response headers,
  generated documents and spreadsheets, emails, prompts, outbound requests, logs.

Search for every sink; do not sample a few files and generalise.

## 2. Checklist

Drop rows the stack does not have. Add rows the project's rules name.

| # | Check | Passes when |
| --- | --- | --- |
| 1 | SQL | Only the ORM or bound parameters; search text is escaped for `LIKE`; sort and filter columns come from a closed set. String-built SQL appears only in migrations, with fixed identifiers. |
| 2 | HTML sinks | No raw-HTML sink (`dangerouslySetInnerHTML`, `innerHTML`, a template `safe` filter) receives data. A constant is fine. |
| 3 | Rich text and links | Stored as structured data and checked on the server against a node and attribute allowlist; links allow `http` and `https` only. |
| 4 | URLs in `href`, `src`, redirects | The scheme is validated on the server; no redirect target comes from a query parameter. |
| 5 | Generated files | Emails escape values; XML and office files are built by a library or escaped; a spreadsheet cell holding data is never a formula; download names are encoded in `Content-Disposition`. |
| 6 | Uploads | A type allowlist without HTML or SVG; the size bound is enforced by the storage request, not only declared; content is sniffed before parsing; downloads carry `nosniff` or are attachments. |
| 7 | Request validation | Every field is bounded (length, range, item count); unknown shapes are rejected; free-form objects are validated before storage. |
| 8 | AI output | A provider-enforced schema, validated again by the app, then the same validators user input passes before anything is stored. Tool arguments are validated and scoped to the run. Source text is labelled data, never instructions. |
| 9 | Outbound fetches | A URL from a user, page or model is fetched only through one guard: `http(s)`, public addresses, the connection pinned to the resolved address, redirects re-validated, size and time bounded. Host allowlists compare a full origin with its trailing slash. |
| 10 | Sessions and CSRF | Cookies are `HttpOnly`, `Secure`, `SameSite`; state-changing requests from another origin are refused; webhook signatures are compared in constant time. |
| 11 | Tenant and authorization mechanism | The tenant comes from the session, never the request. Route-by-route authorization is the review's job; say so. |
| 12 | Response headers | Framing limit, `nosniff`, referrer policy and HSTS on every route; a script policy without `'unsafe-inline'` wherever user or model data renders. |
| 13 | Exposed surface | Interactive API docs, the schema, dev sign-in and dev storage are not reachable on the public site outside development. |
| 14 | Production config | Settings refuse fake and development modes outside development; a secret shared between tiers is required before release. |
| 15 | Regex cost | No pattern backtracks super-linearly on text an outsider can shape. |
| 16 | Dependencies | The audit tool reports no known advisory for production dependencies. |
| 17 | Secrets and errors | No secret in code, the client bundle, logs or error bodies; validation errors do not echo input. |

## 3. Verify, do not infer

- **Probe the running app.** Read the response headers of a public page and a signed-in page;
  request the docs and schema routes without a session; send a state-changing request with a
  foreign `Origin`; put a quote in a search parameter. Unauthenticated, read-only probes against
  a local or test environment only, never production.
- **Enumerate inputs mechanically.** Walk the generated API schema for strings without a length
  bound, arrays without an item bound and objects with free properties. Then read the code for
  each hit: a bound may live in the domain layer, where the schema cannot show it.
- **Time a suspect regex** with hostile input instead of reasoning about it.
- **Run the audit tools** on the locked production dependencies (`pnpm audit --prod`,
  `npm audit --omit=dev`, `pip-audit` on the lock export) and say which advisories are reachable.
- **Check a production build**, not the dev server, for header and script-policy claims.
- **Hosted secrets:** check presence by key, length or a hash comparison. Never print a value.

## 4. Report

```
## Security audit - <scope>

Verdict: <one sentence>

### Checklist
| # | Check | Result |

### Findings (most severe first)
- <severity>: <what is wrong> - <file:line> - <what an attacker gains> - <fix>

### Why the passes hold
- <check>: <the evidence>

### Not covered
- <what was not checked and why>
```

## Rules

- A finding needs evidence in the code or a probe. A row you did not check is "not covered",
  never a pass.
- Rank by what an attacker gains, and say whether the path is reachable.
- Keep exploit detail for a vulnerability in someone else's code out of public issues.
- Fix nothing unless asked. When asked, one commit and one surgical test per concern, and the
  pull request lists what was not verified.
