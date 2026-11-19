# Fixes

Load only when asked to fix. Each fix is proved with the same probe, before and after, and lands
with a lowered budget.

## One read transaction per request

A request-scoped holder (`AsyncLocalStorage` in TypeScript, a `ContextVar` in Python) set by
middleware for every request. A route's worker thread or async task cannot send a variable
back, so the holder is a mutable object, not the session.

- The first snapshot read opens a `REPEATABLE READ` transaction in the holder; later snapshot
  reads join it. Apply the access scope only when it changes; send only the settings that
  changed.
- Reuse results inside it: the ORM's statement hook (SQLAlchemy `do_orm_execute`, a Drizzle
  wrapper keyed by SQL plus parameters) returns the rows of a query already run. Clear them on
  any write in that transaction and whenever the scope changes.
- A write unit of work ends the shared snapshot **before** it takes its connection, and again
  after it commits, so the next read sees the commit.
- Outbound calls end it too: wrap the HTTP client's send method and the SDK's request method
  once (httpx transport, `fetch` wrapper, botocore endpoint) and call a neutral
  `beforeNetworkCall()` hook the database layer registers. Never patch each adapter.
- The middleware commits at the end and turns a failed commit into a 500: a read may have
  written an access-log row.
- Tests: one transaction for a read request; a write then a read in one request sees the
  write; an outbound call and a command both end the snapshot. Each fails with the fix removed.

## Read-only use cases on the snapshot

A query class takes the snapshot unit of work in composition. A class with both reads and
commands gets an optional `snapshot` dependency and reads through `(snapshot ?? uow)`; commands
keep the write one. A read that only took a lock for a consistent view drops it: the snapshot is
consistent.

## No query per item

- **Canonical case statement.** `findUnit(caseId, unitId)` and `listForUnit(caseId, unitId)` run
  the same statement for the whole case and filter in memory; inside the shared snapshot the
  repeated statement is served from its rows. Keep locking variants (`FOR UPDATE`) exact.
- **Batch methods** for id lists: `findMany(ids)`, `listForRuns(runIds)`, `filesById(ids)`.
  Collect the ids first, read once, then loop over the map.
- **Lock and load once per command.** A repository that locks rows one by one locks and loads
  the aggregate's rows once per transaction and forgets them on its own writes.
- **Batch inserts.** One multi-row `INSERT … ON CONFLICT DO NOTHING RETURNING id`; add child rows
  together so they flush as one statement. Drop per-row existence checks the caller already made
  under a lock.
- Seed fixtures with several units, documents and messages, or per-item loops stay invisible.

## Reads never write

Build the default a read needs in memory (`grants(store: false)`) and store it only in the
command that already takes the lock. Two concurrent first reads inserting the same key is a
500, not a race to ignore.

## Session checks

Cache session validity per process for a short window bounded by the session's expiry, keyed by
the token hash; sign-out forgets it. Never cache the resolved role or membership: read it in
the request's snapshot, so role changes apply on the next request. Note the sign-out window on
other instances as a known trade-off.

## No browser waterfalls

- Each page gets a feature `prefetch<Page>(client, …)` returning the prefetch promises for
  every read its components render on open, with their exact arguments (page 0, default
  filters, parsed URL params). Share the URL parser between the client hook and the server page.
- Give a prefetched query a real `staleTime`; derive "changed since the page opened" from
  `isFetchedAfterMount`.
- A read that only renders after another (a role check, a selected item) is prefetched anyway;
  a binary artefact (a rendered preview) may load in the browser.

## Cold start

Load vendor SDKs on first use behind their port (a factory the container calls only when a job
needs it). Turn off error-reporting auto-instrumentation in processes that do not call those
SDKs, and list the integrations they do use. Measure import time at 1 vCPU before and after.
