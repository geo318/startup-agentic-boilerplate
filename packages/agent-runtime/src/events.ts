import { closeSync, existsSync, openSync, readFileSync, appendFileSync, unlinkSync, writeSync } from "node:fs";
import { canonical, sha256 } from "./hash.ts";

export type LoggedEvent = { seq: number; prev: string; type: string; data: unknown; hash: string; ts?: string }; // ts: ISO time; hashed when present, so older logs without it still verify

// Append-only hash-chained JSONL. Lives in controller state, outside any worker-writable tree.
// Single writer: an exclusive lockfile; a stale lock blocks (a human must remove it) rather than being stolen.
export class EventLog {
  #path: string;
  #lock: string;
  #fd: number | undefined;
  constructor(path: string) {
    this.#path = path;
    this.#lock = `${path}.lock`;
  }
  open(): this {
    try {
      this.#fd = openSync(this.#lock, "wx");
      writeSync(this.#fd, String(process.pid));
    } catch {
      throw new Error(`event log locked by another writer: ${this.#lock}`);
    }
    return this;
  }
  close(): void {
    if (this.#fd !== undefined) closeSync(this.#fd);
    this.#fd = undefined;
    if (existsSync(this.#lock)) unlinkSync(this.#lock);
  }
  read(): LoggedEvent[] {
    if (!existsSync(this.#path)) return [];
    return readFileSync(this.#path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  // Checks the chain present on disk; without an external anchor, tail truncation is not detectable.
  verify(): LoggedEvent[] {
    let prev = "";
    const events = this.read();
    events.forEach((e, i) => {
      const body = canonical({ seq: e.seq, prev: e.prev, type: e.type, data: e.data, ...(e.ts ? { ts: e.ts } : {}) });
      if (e.seq !== i || e.prev !== prev || e.hash !== sha256(body)) {
        throw new Error(`event log corrupt at seq ${i}`);
      }
      prev = e.hash;
    });
    return events;
  }
  append(type: string, data: unknown): LoggedEvent {
    if (this.#fd === undefined) throw new Error("event log not open for writing");
    const events = this.verify();
    const prev = events.at(-1)?.hash ?? "";
    const seq = events.length;
    const ts = new Date().toISOString();
    const hash = sha256(canonical({ seq, prev, type, data, ts }));
    const event = { seq, prev, type, data, ts, hash };
    appendFileSync(this.#path, `${JSON.stringify(event)}\n`);
    return event;
  }
}

// A timing/diagnostic event after a provider crash must not hide an unsettled call.
// A state with uncertainBilling records that resume already charged its unknown usage.
export function unsettledCall(events: LoggedEvent[]): LoggedEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (
      e.type === "ledger" ||
      e.type === "billing_uncertain" ||
      (e.type === "state" && (e.data as { uncertainBilling?: boolean })?.uncertainBilling)
    )
      return undefined;
    if (e.type === "inflight") return e;
  }
  return undefined;
}
