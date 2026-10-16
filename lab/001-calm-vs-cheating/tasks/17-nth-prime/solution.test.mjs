import assert from "node:assert/strict";
import { test } from "node:test";
import { nthPrime } from "./solution.mjs";

test("one-based", () => {
  assert.equal(nthPrime(1), 2);
});

test("zero-based", () => {
  assert.equal(nthPrime(1), 3);
});
