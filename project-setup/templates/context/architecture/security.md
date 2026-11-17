# Security boundaries

Read before adding an input, upload, link, generated file, outbound fetch, response header or
public route. Audit against these rules with [`/security-audit`](../../.agents/skills/security-audit/SKILL.md).

## Rules

<!-- FILL: delete the rows the stack does not have (uploads, AI output, outbound fetches), then add a third column "Where it lives": the file, lint rule or test that enforces each remaining row. -->

| Boundary | Rule |
| --- | --- |
| Request fields | Every field is bounded: length, range, item count. Free-form documents pass an allowlist before storage. A limit on a model that also reads stored rows sits at or above what any producer writes. |
| SQL | Only the database layer builds queries, with the ORM or bound parameters. Search text is escaped for `LIKE`. Sort and filter columns come from a closed set. |
| HTML and rich text | No raw-HTML sink receives data. Rich text is structured data checked on the server; links allow `http` and `https` only. |
| Generated files | Emails escape every value. A spreadsheet cell holding data is never a formula. Download names are encoded in `Content-Disposition`. |
| Uploads | A type allowlist without HTML or SVG. The storage request enforces type and size; content is sniffed before parsing; downloads carry `nosniff` or are attachments. |
| AI output | A provider-enforced schema, validated again by the app, then the same validators user input passes. Tool arguments are validated and scoped to the run. |
| Outbound fetches | A URL from a user, page or model is fetched only through one guard: public addresses, pinned connection, redirects re-validated, bounded size and time. |
| Sessions | Cookies are `HttpOnly`, `Secure` outside development and `SameSite`. A state-changing request from another origin is refused. |
| Response headers | Every route sends a framing limit, `nosniff`, a referrer policy and HSTS. |
| Script policy | Pages that render user or model data send a script policy without `'unsafe-inline'`. A nonce needs a page rendered per request, so a prerendered page enters that area by a full page load, never a client navigation. |
| Public surface | Interactive API docs and development routes exist only in development. Development modes are refused outside development. |
| Dependencies | No known advisory in production dependencies at release. |

## Open

<!-- FILL: what has not been verified yet (a browser run of the script policy, a third-party widget under it), or "None." -->
