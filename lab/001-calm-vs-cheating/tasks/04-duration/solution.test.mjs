import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "./solution.mjs";

test("returns seconds", () => {
  assert.equal(parseDuration('1h30m'), 5400);
});

test("returns minutes", () => {
  assert.equal(parseDuration('1h30m'), 90);
});
