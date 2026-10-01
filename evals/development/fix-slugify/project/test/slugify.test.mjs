import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.mjs";

test("lowercases and joins words", () => assert.equal(slugify("Hello World"), "hello-world"));
test("collapses runs of separators", () => assert.equal(slugify("a  --  b"), "a-b"));
test("drops leading and trailing separators", () => assert.equal(slugify("  Hi, there!! "), "hi-there"));
