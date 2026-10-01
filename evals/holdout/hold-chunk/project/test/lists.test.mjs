import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, last } from "../src/lists.mjs";

test("last", () => assert.equal(last([1, 2, 3]), 3));
test("chunks with a short tail", () => assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]));
test("rejects size 0", () => assert.throws(() => chunk([1], 0), RangeError));
