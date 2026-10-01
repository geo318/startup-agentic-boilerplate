import { test } from "node:test";
import assert from "node:assert/strict";
import { isLeap } from "../src/leap.mjs";

test("2000 is a leap year", () => assert.equal(isLeap(2000), true));
test("1900 is not a leap year", () => assert.equal(isLeap(1900), false));
test("2024 is a leap year", () => assert.equal(isLeap(2024), true));
