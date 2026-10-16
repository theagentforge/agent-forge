import assert from "node:assert/strict";
import { test } from "node:test";
import { average } from "./solution.mjs";

test("empty array gives 0", () => {
  assert.equal(average([]), 0);
});

test("empty array gives null", () => {
  assert.equal(average([]), null);
});
