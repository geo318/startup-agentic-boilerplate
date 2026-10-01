import { test } from "node:test";
import assert from "node:assert/strict";
import { titleCase } from "../src/title.mjs";

test("capitalises words", () => assert.equal(titleCase("hello wORLD"), "Hello World"));
test("keeps spacing", () => assert.equal(titleCase("a  b"), "A  B"));
