import { test } from "node:test";
import assert from "node:assert/strict";
import { daysBetween } from "../src/calendar.mjs";

test("same day", () => assert.equal(daysBetween("2026-03-01", "2026-03-01"), 0));
test("simple range", () => assert.equal(daysBetween("2026-03-01", "2026-03-11"), 10));
test("across a leap day", () => assert.equal(daysBetween("2028-02-28", "2028-03-01"), 2));
test("negative", () => assert.equal(daysBetween("2026-03-11", "2026-03-01"), -10));
