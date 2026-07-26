import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCredentialToolOptions } from "../../dist/src/credential-tool-options.js";

test("credential tool options share one strict allowlist and normalization", () => {
  const input = {
    session: "model-session",
    passwordSelector: "#password",
    currentPasswordSelector: "#current-password",
    usernameSelector: "#username",
    confirmPasswordSelector: "#confirm-password",
    submitSelector: "#submit",
    id: 42,
    username: "alice",
    label: "work",
    generate: true,
    length: "18",
    includeSymbols: false,
    matchMode: "exact-origin",
    submit: false,
    code: "danger()",
    note: "ignored",
    password: "must-not-pass",
  };

  const expected = {
    session: "model-session",
    generate: true,
    passwordSelector: "#password",
    currentPasswordSelector: "#current-password",
    usernameSelector: "#username",
    confirmPasswordSelector: "#confirm-password",
    submitSelector: "#submit",
    id: "42",
    username: "alice",
    label: "work",
    length: 18,
    includeSymbols: false,
    matchMode: "exact-origin",
    submit: false,
  };
  assert.deepEqual(normalizeCredentialToolOptions(input), expected);
  assert.deepEqual(
    normalizeCredentialToolOptions(input, { session: "trusted-session" }),
    { ...expected, session: "trusted-session" },
  );
});

test("credential tool options preserve boolean submit and validate matchMode", () => {
  assert.deepEqual(normalizeCredentialToolOptions({}), {
    session: "default",
    generate: false,
  });
  assert.equal(normalizeCredentialToolOptions({ submit: true }).submit, true);
  assert.equal(normalizeCredentialToolOptions({ submit: false }).submit, false);
  assert.equal(
    Object.hasOwn(normalizeCredentialToolOptions({ submit: "true" }), "submit"),
    false,
  );
  assert.throws(
    () => normalizeCredentialToolOptions({ matchMode: "same-site" }),
    /matchMode.*exact-origin/,
  );
});
