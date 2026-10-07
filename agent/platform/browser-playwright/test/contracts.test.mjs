import test from "node:test";
import assert from "node:assert/strict";

import { truncateUtf8, validateLocatorShape } from "../src/server.mjs";

test("typed user-facing locators are accepted", () => {
  assert.deepEqual(
    validateLocatorShape({
      kind: "role",
      role: "button",
      name: "Save",
      exact: true,
    }),
    {
      kind: "role",
      role: "button",
      name: "Save",
      exact: true,
    },
  );
  assert.equal(
    validateLocatorShape({
      kind: "label",
      value: "Email",
      index: 0,
    }).kind,
    "label",
  );
  assert.equal(
    validateLocatorShape({
      kind: "test_id",
      value: "submit",
    }).kind,
    "test_id",
  );
});

test("raw selector engines, scripts and unsupported fields are rejected", () => {
  for (const locator of [
    { kind: "css", value: "#submit" },
    { kind: "xpath", value: "//button" },
    { kind: "javascript", value: "() => document.body" },
    { kind: "text", value: "Save", selector: "#save" },
    { kind: "role", role: "document", name: "Page" },
  ]) {
    assert.throws(() => validateLocatorShape(locator));
  }
});

test("locator bounds and index are fail-closed", () => {
  assert.throws(() =>
    validateLocatorShape({
      kind: "text",
      value: "x".repeat(257),
    }),
  );
  assert.throws(() =>
    validateLocatorShape({
      kind: "label",
      value: "Email",
      index: 10,
    }),
  );
  assert.throws(() =>
    validateLocatorShape({
      kind: "placeholder",
      value: "bad\nvalue",
    }),
  );
});

test("UTF-8 truncation never cuts a multibyte character", () => {
  const source = "abc🙂def";
  const result = truncateUtf8(source, 5);
  assert.equal(result.value, "abc");
  assert.equal(result.truncated, true);

  const unchanged = truncateUtf8("short", 64);
  assert.deepEqual(unchanged, { value: "short", truncated: false });
});
