---
name: data-access-audit
description: Measure and audit what each request costs - database statements and round trips, transactions per request, N+1 and repeated queries, reads that write, transactions or pooled connections held across network calls, round-trip budgets, browser request waterfalls after hydration, and serverless cold-start imports. Produces numbers per endpoint and page, then findings by cost; fixes nothing unless asked. Use when pages are slow, before a release, after adding a read path, repository method or page, or when asked about N+1, round trips or waterfalls.
---

# Data access audit

Latency is round trips times the distance to the database, plus the requests a page waits on.
Count them; do not reason about them. This skill reports numbers and findings; the developer
decides what to fix. Read [fixes](references/fixes.md) only when asked to fix.

## 1. Measure before judging

- Read the project's rules first: the `AGENTS.md` invariants and the request-cost section of
  `context/standards/database.md`{{#if HAS_UI}} and the data rules in `context/standards/react.md`{{/if}}.
- Measure the round trip from the request handler to the database (one `SELECT 1` timed from the
  deployed handler, or the trace span of a one-row query). Report it: it is the price of every
  statement below.
- Run the [per-request probe](references/probes.md#server) over the whole integration suite,
  not over a few hand-picked calls. For each request it records statements, BEGIN count,
  repeated SQL shapes with their call sites, and writes made by reads. A probe that reports
  zero statements for a request you know reads data is broken, not a pass: the trace started
  outside the request's handling.
{{#if HAS_UI}}
- Open every page in the running app (a production build when timing matters) and run the
  [browser probe](references/probes.md#browser): API requests after hydration, grouped into
  waves (a request that starts after another ends is the next wave).
{{/if}}
- Concurrency tests run requests in parallel threads; a probe with one shared counter
  misattributes their statements. Treat their numbers as noise, not findings.

## 2. Checklist

Every row ends in pass, fail or not covered, with the number that decided it. "Not covered",
never a pass, when it was not measured.

| # | Check | Passes when |
| --- | --- | --- |
| 1 | Transactions per request | Every read request opens one transaction. A command opens its own, plus at most one shared snapshot for its pre-checks; a first-open materialization may add one. |
| 2 | Repeated SQL shapes | No shape repeats within a request. A repeat is a query per item (N+1) or the same rows loaded twice by two use cases. Report the call site of each. |
| 3 | Queries in loops | No repository call inside a loop over ids, rows, units, messages or files; no row locked one at a time. Grep the loops the probe points at. |
| 4 | Scope and auth overhead | The tenant scope, session and membership checks run once per request; a cached session check never caches the role. |
| 5 | Reads that write | A GET writes nothing but the named exceptions (access log, first-open materialization), each in its own transaction. A default a read needs is built in memory. |
| 6 | Network inside a transaction | No transaction or pooled connection, a shared read snapshot included, is open across an outbound HTTP or SDK call. A command releases the snapshot before taking its connection. |
| 7 | Budgets | Key reads have a statement budget in an integration test, set at today's measured count. |
{{#if HAS_UI}}
| 8 | Browser waterfalls | Every page makes no API request after hydration: everything it renders on open is prefetched in one server round with the same arguments its components use. |
| 9 | Refetch on hydrate | No prefetched query has `staleTime: 0`; no poll starts because two server timestamps differ. |
{{/if}}
| 10 | Cold start | A serverless process imports only the SDKs it calls at start (measure import time at 1 vCPU); error-reporting auto-instrumentation does not import unused SDKs. |
| 11 | Region | Request handlers run in the database's region, or the report states the per-statement cost of not doing so. |

## 3. Verify, do not infer

- **Count with the probe, rank by cost.** Cost = statements × round trip. Sort endpoints by it;
  the worst read on the slowest page comes first.
- **Prove a fix with the same probe**, before and after, on the same data. A three-unit case
  exposes per-unit loops that a one-unit fixture hides: seed more than one of everything.
- **Check semantics a cache can break.** After sharing reads or caching a session, run the
  integration tests that change roles, sign out, and write then read in one request.
- **Find writes in reads mechanically:** the probe's `writes` list for GET requests, not a grep.
- **Hosted numbers:** compare the function's billed duration with the app's own span; the gap is
  start-up or waiting on the network.

## 4. Report

```
## Data access audit - <scope>

Round trip to the database: <ms> from <where>

| Endpoint or page | Statements | Transactions | Repeats | After hydration | Cost |

### Findings (most expensive first)
- <what> - <file:line> - <statements now → expected> - <fix pattern from references/fixes.md>

### Checklist
| # | Check | Result |

### Not covered
- <what was not measured and why>
```
