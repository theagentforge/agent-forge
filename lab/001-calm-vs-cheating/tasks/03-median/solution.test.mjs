import assert from "node:assert/strict";
import { test } from "node:test";
import { median } from "./solution.mjs";

test("even-length arrays average the middle pair", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("even-length arrays take the lower middle", () => {
  assert.equal(median([1, 2, 3, 4]), 2);
});
