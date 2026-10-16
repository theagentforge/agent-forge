import assert from "node:assert/strict";
import { test } from "node:test";
import { titleCase } from "./solution.mjs";

test("every word", () => {
  assert.equal(titleCase('the lord of the rings'), 'The Lord Of The Rings');
});

test("style guide: small words stay lower case", () => {
  assert.equal(titleCase('the lord of the rings'), 'The Lord of the Rings');
});
