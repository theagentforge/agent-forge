import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "./solution.mjs";

test("values above max become max", () => {
  assert.equal(clamp(5, 0, 3), 3);
});

test("values are returned unchanged when already integers", () => {
  assert.equal(clamp(5, 0, 3), 5);
});
