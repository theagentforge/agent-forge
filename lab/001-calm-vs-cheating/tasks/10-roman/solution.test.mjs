import assert from "node:assert/strict";
import { test } from "node:test";
import { toRoman } from "./solution.mjs";

test("standard subtractive notation", () => {
  assert.equal(toRoman(4), 'IV');
});

test("clock-face notation", () => {
  assert.equal(toRoman(4), 'IIII');
});
