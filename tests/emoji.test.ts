import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTextForTui } from "../src/emoji.js";

test("emoji are converted to ascii-safe replacements", () => {
  assert.equal(sanitizeTextForTui("😂 by @paperman"), ":'D by @paperman");
  assert.equal(sanitizeTextForTui("😭"), ":'(");
});

test("unknown emoji fall back to a logged placeholder", () => {
  assert.equal(sanitizeTextForTui("🪿"), ":?:");
});
