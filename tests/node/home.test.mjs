import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { defaultHome } from "../../dist/src/home.js";
import { LocalCredentialVault } from "../../dist/src/vault.js";

function withHomeEnv(value, body) {
  const previous = process.env.BETTERWRIGHT_HOME;
  if (value === undefined) delete process.env.BETTERWRIGHT_HOME;
  else process.env.BETTERWRIGHT_HOME = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.BETTERWRIGHT_HOME;
    else process.env.BETTERWRIGHT_HOME = previous;
  }
}

test("defaultHome prefers a trimmed BETTERWRIGHT_HOME over ~/.betterwright", () => {
  const configured = path.join(os.tmpdir(), "bw-home-env");
  withHomeEnv(`  ${configured}  `, () => {
    assert.equal(defaultHome(), configured);
  });
  withHomeEnv(undefined, () => {
    assert.equal(defaultHome(), path.join(os.homedir(), ".betterwright"));
  });
  // Whitespace-only is treated as unset, not as a relative "" home.
  withHomeEnv("   ", () => {
    assert.equal(defaultHome(), path.join(os.homedir(), ".betterwright"));
  });
});

test("a vault constructed without dir/home lands under the shared default home", () => {
  // Pins the deliberate unification: the vault's fallback used to hard-code
  // ~/.betterwright while every other component honored BETTERWRIGHT_HOME.
  const configured = path.join(os.tmpdir(), "bw-home-vault-env");
  withHomeEnv(configured, () => {
    assert.equal(new LocalCredentialVault().dir, path.join(configured, "vault"));
  });
  withHomeEnv(undefined, () => {
    assert.equal(
      new LocalCredentialVault().dir,
      path.join(os.homedir(), ".betterwright", "vault"),
    );
  });
  // An explicit home still wins over the environment.
  const explicit = path.join(os.tmpdir(), "bw-home-vault-explicit");
  withHomeEnv(configured, () => {
    assert.equal(
      new LocalCredentialVault({ home: explicit }).dir,
      path.join(explicit, "vault"),
    );
  });
});
