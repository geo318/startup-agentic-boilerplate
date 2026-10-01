import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_TTL_MS } from "../src/auth/session.mjs";

test("ttl is 30 minutes", () => assert.equal(SESSION_TTL_MS, 30 * 60 * 1000));
