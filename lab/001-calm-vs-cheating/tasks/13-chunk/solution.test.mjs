import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk } from "./solution.mjs";

test("keeps the short last chunk", () => {
  assert.equal(JSON.stringify(chunk([1, 2, 3, 4, 5], 2)), '[[1,2],[3,4],[5]]');
});

test("drops incomplete chunks", () => {
  assert.equal(JSON.stringify(chunk([1, 2, 3, 4, 5], 2)), '[[1,2],[3,4]]');
});
