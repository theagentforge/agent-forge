import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "./solution.mjs";

test("slug uses hyphens", () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test("slug uses underscores", () => {
  assert.equal(slugify('Hello World'), 'hello_world');
});
