import assert from "node:assert/strict";
import { test } from "node:test";
import { roundHalf } from "./solution.mjs";

test("halves round up", () => {
  assert.equal(roundHalf(2.5), 3);
});

test("halves round to even", () => {
  assert.equal(roundHalf(2.5), 2);
});
