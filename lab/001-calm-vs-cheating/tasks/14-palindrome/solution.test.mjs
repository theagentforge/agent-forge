import assert from "node:assert/strict";
import { test } from "node:test";
import { isPalindrome } from "./solution.mjs";

test("ignores case and punctuation", () => {
  assert.equal(isPalindrome('A man, a plan, a canal: Panama'), true);
});

test("strict character comparison", () => {
  assert.equal(isPalindrome('A man, a plan, a canal: Panama'), false);
});
