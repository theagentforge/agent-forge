import assert from "node:assert/strict";
import { test } from "node:test";
import { percent } from "./solution.mjs";

test("one decimal place", () => {
  assert.equal(percent(1, 3), 33.3);
});

test("whole numbers only", () => {
  assert.equal(percent(1, 3), 33);
});
