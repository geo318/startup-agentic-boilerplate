import { test } from "node:test";
import assert from "node:assert/strict";
import { discount } from "../src/pricing.mjs";

test("no loyalty, no discount", () => assert.equal(discount(100, 0), 100));
