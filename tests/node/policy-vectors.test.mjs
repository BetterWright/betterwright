// Runs the NetworkPolicy conformance vectors in tests/fixtures/policy-vectors.json.
// The fixture is the reviewable source of truth for every allow/deny decision;
// a policy change that alters any decision fails here with the vector's name.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NetworkPolicy } from "../../src/policy.mjs";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "policy-vectors.json",
);
const { vectors } = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function policyFromSnakeCase(options) {
  return new NetworkPolicy({
    allowPrivateNetwork: options.allow_private_network,
    allowLoopback: options.allow_loopback,
    allowHosts: options.allow_hosts,
    blockHosts: options.block_hosts,
  });
}

test("policy conformance vectors", () => {
  assert.ok(vectors.length > 50, "fixture should not be silently truncated");
  for (const vector of vectors) {
    const decision = policyFromSnakeCase(vector.policy).check(vector.url);
    assert.equal(
      Boolean(decision.allowed),
      vector.allowed,
      `${vector.name}: expected allowed=${vector.allowed}, got ${JSON.stringify(decision)}`,
    );
    if (vector.reason_contains) {
      assert.ok(
        String(decision.reason || "").includes(vector.reason_contains),
        `${vector.name}: reason ${JSON.stringify(decision.reason)} should contain ${JSON.stringify(vector.reason_contains)}`,
      );
    }
  }
});
