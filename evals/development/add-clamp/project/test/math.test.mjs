import { test } from "node:test";
import assert from "node:assert/strict";
import { clamp, sum } from "../src/math.mjs";

test("sum adds", () => assert.equal(sum([1, 2, 3]), 6));
test("clamp limits above", () => assert.equal(clamp(5, 0, 3), 3));
test("clamp limits below", () => assert.equal(clamp(-1, 0, 3), 0));
test("clamp keeps values in range", () => assert.equal(clamp(2, 0, 3), 2));
test("clamp rejects an inverted range", () => assert.throws(() => clamp(1, 3, 0), RangeError));
