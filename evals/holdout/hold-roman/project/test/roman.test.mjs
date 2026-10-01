import { test } from "node:test";
import assert from "node:assert/strict";
import { toRoman } from "../src/roman.mjs";

test("small", () => assert.equal(toRoman(4), "IV"));
test("large", () => assert.equal(toRoman(1994), "MCMXCIV"));
test("zero throws", () => assert.throws(() => toRoman(0), RangeError));
