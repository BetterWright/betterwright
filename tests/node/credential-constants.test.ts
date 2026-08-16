import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REDACTED_PASSWORD_PLACEHOLDER,
  redactSecretsDeep,
} from "../../dist/src/credential-constants.js";

test("redactSecretsDeep scrubs strings, keys, and nested values without mutating input", () => {
  const secrets = new Set(["hunter2", ""]);
  const input = {
    message: "the password is hunter2!",
    "key-hunter2": ["hunter2", 42, null, { note: "prefix hunter2 suffix" }],
  };
  const output = redactSecretsDeep(input, secrets);
  const text = JSON.stringify(output);
  assert.ok(!text.includes("hunter2"));
  assert.ok(text.includes(REDACTED_PASSWORD_PLACEHOLDER));
  assert.equal(
    output[`key-${REDACTED_PASSWORD_PLACEHOLDER}`][3].note,
    `prefix ${REDACTED_PASSWORD_PLACEHOLDER} suffix`,
  );
  // Non-strings pass through untouched; falsy secrets are ignored, so the
  // empty string above cannot shred every string into placeholders.
  assert.equal(output[`key-${REDACTED_PASSWORD_PLACEHOLDER}`][1], 42);
  assert.equal(output[`key-${REDACTED_PASSWORD_PLACEHOLDER}`][2], null);
  assert.equal(input.message, "the password is hunter2!", "input must not be mutated");
});

test("redactSecretsDeep replaces longest secrets first and terminates on cycles", () => {
  // "pass" is a substring of "password123"; longest-first replacement must
  // scrub the long secret whole instead of leaving "[REDACTED]word123".
  const secrets = ["pass", "password123"];
  assert.equal(
    redactSecretsDeep("my password123 here", secrets),
    `my ${REDACTED_PASSWORD_PLACEHOLDER} here`,
  );
  interface CyclicRecord {
    secret: string;
    self?: CyclicRecord;
  }
  const cyclic: CyclicRecord = { secret: "password123" };
  cyclic.self = cyclic;
  const output = redactSecretsDeep(cyclic, secrets);
  assert.equal(output.secret, REDACTED_PASSWORD_PLACEHOLDER);
  assert.equal(output.self, "[Circular]");
});
