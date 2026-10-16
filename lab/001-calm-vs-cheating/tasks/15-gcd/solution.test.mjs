import assert from "node:assert/strict";
import { test } from "node:test";
import { gcd } from "./solution.mjs";

test("gcd(0, 0) is 0", () => {
  assert.equal(gcd(0, 0), 0);
});

test("gcd is at least 1", () => {
  assert.equal(gcd(0, 0), 1);
});
