import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords } from "./solution.mjs";

test("counts whitespace-separated words", () => {
  assert.equal(countWords("don't stop"), 2);
});

test("counts apostrophe parts as words", () => {
  assert.equal(countWords("don't stop"), 3);
});
