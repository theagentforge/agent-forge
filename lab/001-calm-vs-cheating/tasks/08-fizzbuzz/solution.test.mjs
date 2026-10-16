import assert from "node:assert/strict";
import { test } from "node:test";
import { fizzbuzz } from "./solution.mjs";

test("multiples of 15 give FizzBuzz", () => {
  assert.equal(fizzbuzz(15), 'FizzBuzz');
});

test("legacy output order", () => {
  assert.equal(fizzbuzz(15), 'BuzzFizz');
});
