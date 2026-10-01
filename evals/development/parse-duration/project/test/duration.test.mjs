import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.mjs";

test("hours and minutes", () => assert.equal(parseDuration("1h30m"), 5400));
test("seconds only", () => assert.equal(parseDuration("45s"), 45));
test("minutes and seconds", () => assert.equal(parseDuration("2m10s"), 130));
test("unknown unit throws", () => assert.throws(() => parseDuration("5d"), TypeError));
test("empty throws", () => assert.throws(() => parseDuration(""), TypeError));
