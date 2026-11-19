# Probes

Temporary measuring tools. Keep them out of the repository (a scratch folder, a plugin passed on
the command line) unless the project turns one into a budget test.

## Server

Wrap the test client's request method; count every statement the driver sends during it. Group
statements by **shape**: the SQL with bound values replaced by `?` and `IN (?, ?, …)` collapsed,
so the same query for different ids counts as a repeat.

Record per request: method, path with ids replaced by `{id}`, statement count, BEGIN count,
shapes seen more than once with the two innermost application frames that issued them, and the
first words of every INSERT, UPDATE or DELETE.

### TypeScript (node-postgres or Drizzle)

```ts
// probe.ts: loaded by the test runner's setup file, never by the app.
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

type Trace = { statements: string[]; stacks: Map<string, string> };
const current = new AsyncLocalStorage<Trace>();
const shape = (sql: string) =>
  sql.replace(/\$\d+/g, "?").replace(/\((\?,\s*)+\?\)/g, "(?)").replace(/\s+/g, " ").slice(0, 160);

const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<typeof query>) {
  const trace = current.getStore();
  const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
  if (trace) {
    trace.statements.push(shape(text));
    trace.stacks.set(shape(text), new Error().stack?.split("\n").slice(2, 5).join(" < ") ?? "");
  }
  return query.apply(this, args);
} as typeof query;

/** Run one request under the probe and append its numbers to a JSON-lines file. */
export async function probed<T>(label: string, send: () => Promise<T>): Promise<T> {
  const trace: Trace = { statements: [], stacks: new Map() };
  try {
    return await current.run(trace, send);
  } finally {
    const counts = Map.groupBy(trace.statements, (s) => s);
    const repeats = [...counts].filter(([, list]) => list.length > 1);
    console.log(JSON.stringify({
      label,
      statements: trace.statements.length,
      transactions: trace.statements.filter((s) => s.startsWith("BEGIN")).length,
      repeats: repeats.map(([s, list]) => ({ n: list.length, s, at: trace.stacks.get(s) })),
      writes: trace.statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s)),
    }));
  }
}
```

Wrap the HTTP test helper (`supertest`, `app.request`, `fetch` against the test server) in
`probed`, run the integration suite, then sort the JSON lines by `statements` and by the largest
`repeats[].n`.

### Python (SQLAlchemy)

```python
# n1probe.py: run with `PYTHONPATH=<scratch> pytest -p n1probe -m integration`.
import collections, json, os, re, traceback
from fastapi.testclient import TestClient
from sqlalchemy import Engine, event

state = {"log": None, "sites": {}}

def shape(sql):
    sql = re.sub(r"%\(\w+\)s(::\w+(\[\])?)?", "?", sql)
    return " ".join(re.sub(r"\(\?(, \?)*\)", "(?)", sql).split())[:160]

@event.listens_for(Engine, "before_cursor_execute")
def statement(conn, cursor, sql, *_):
    if state["log"] is not None:
        s = shape(sql)
        state["log"].append(s)
        frames = [f for f in traceback.extract_stack() if "/src/app/" in f.filename]
        state["sites"][s] = " < ".join(f"{f.filename}:{f.name}" for f in frames[-2:][::-1])

@event.listens_for(Engine, "begin")
def begin(conn):
    if state["log"] is not None:
        state["log"].append("BEGIN")

send = TestClient.request
def request(self, method, url, *args, **kwargs):
    state["log"], state["sites"] = [], {}
    try:
        return send(self, method, url, *args, **kwargs)
    finally:
        log, state["log"] = state["log"], None
        counts = collections.Counter(s for s in log if s != "BEGIN")
        with open(os.environ["N1_OUT"], "a") as out:
            out.write(json.dumps({
                "method": method, "path": re.sub(r"[0-9a-f-]{36}", "{id}", str(url).split("?")[0]),
                "statements": len(log), "transactions": log.count("BEGIN"),
                "repeats": {s: [n, state["sites"].get(s)] for s, n in counts.items() if n > 1},
                "writes": sorted({s.split(" (")[0] for s in log if s.split()[0] in ("INSERT", "UPDATE", "DELETE")}),
            }) + "\n")
TestClient.request = request
```

Ignore repeats of the scope statement (`set_config`, `SET LOCAL`) when the transaction count is
already 1; count them as overhead when it is not.

## Browser

In the running app, open a page, wait for it to settle, then run in the page:

```js
const shown = performance.getEntriesByType("resource")
  .filter((r) => r.name.includes("/api/"))
  .map((r) => ({ path: new URL(r.name).pathname.replace(/[0-9a-f-]{36}/g, ":id"), start: r.startTime, end: r.responseEnd, status: r.responseStatus }))
  .sort((a, b) => a.start - b.start);
let wave = 0, end = -1;
shown.map((r) => { if (end >= 0 && r.start > end + 5) wave++; end = Math.max(end, r.end); return `wave ${wave} ${Math.round(r.start)} ${r.status} ${r.path}`; });
```

An empty list is the pass. A request with status `0` immediately followed by the same request
is a development-mode double mount; confirm on a production build before reporting it.
