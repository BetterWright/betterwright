// Runtime shape check for the `betterwright/worker` subpath. The worker module
// itself is a process entrypoint (importing it hijacks stdin/stdout), so the
// public constant lives in worker-constants.ts — this test both pins the
// constant's contract and proves the module stays importable without side
// effects inside an ordinary unit-test process.

import assert from "node:assert/strict";
import test from "node:test";

import { METADATA_RESOLVER_RULES } from "../../dist/src/worker-constants.js";

test("METADATA_RESOLVER_RULES is a comma-joined --host-resolver-rules value", () => {
  assert.equal(typeof METADATA_RESOLVER_RULES, "string");
  const rules = METADATA_RESOLVER_RULES.split(", ");
  assert.ok(rules.length >= 4, "the metadata blocklist must not silently shrink");
  // Every entry must be a well-formed Chromium resolver rule mapping a host
  // pattern to NOTFOUND — a malformed entry would silently disable the flag.
  for (const rule of rules) {
    assert.match(rule, /^MAP \S+ \^NOTFOUND$/, `malformed resolver rule: ${rule}`);
  }
});

test("METADATA_RESOLVER_RULES blocks the cloud metadata endpoints", () => {
  const rules = METADATA_RESOLVER_RULES.split(", ");
  const patterns = rules.map((rule) => rule.split(" ")[1]);
  // The link-local wildcard is what covers 169.254.169.254, the address every
  // major cloud serves instance credentials on.
  assert.ok(patterns.includes("169.254.*"), "link-local metadata range must be blocked");
  assert.ok(patterns.includes("metadata.google.internal"));
  assert.ok(patterns.includes("metadata.goog"));
  assert.ok(patterns.includes("100.100.100.200"), "Alibaba metadata endpoint must be blocked");
  assert.ok(patterns.includes("fd00:ec2::*"), "the IPv6 EC2 metadata range must be blocked");
});
