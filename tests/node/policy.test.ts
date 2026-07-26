import assert from "node:assert/strict";
import { test } from "node:test";

import { NetworkPolicy } from "../../dist/src/policy.js";

const allow = (policy, url) => policy.check(url).allowed === true;
// Private networks and loopback are open by default; construct a hardened
// policy for the tests that exercise the strict blocking behavior.
const strict = () =>
  new NetworkPolicy({ allowPrivateNetwork: false, allowLoopback: false });

test("public https allowed by default", () => {
  assert.ok(allow(new NetworkPolicy(), "https://example.com/path?q=1"));
});

test("private ranges and loopback allowed by default", () => {
  const policy = new NetworkPolicy();
  for (const url of [
    "http://10.0.0.5/",
    "http://192.168.0.1/",
    "http://127.0.0.1:8000/",
    "http://localhost:5173/",
    "http://nas.lan/",
  ])
    assert.ok(allow(policy, url), url);
});

test("metadata hostname and address blocked", () => {
  const policy = new NetworkPolicy();
  assert.ok(!allow(policy, "http://metadata.google.internal/"));
  assert.ok(!allow(policy, "http://169.254.169.254/latest/meta-data/"));
});

test("metadata cannot be allowlisted", () => {
  const policy = new NetworkPolicy({ allowHosts: ["metadata.google.internal"] });
  assert.equal(policy.check("http://metadata.google.internal/").allowed, false);
});

test("private ranges blocked in strict mode", () => {
  const policy = strict();
  for (const url of [
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.9.9/",
    "http://127.0.0.1:8000/",
  ])
    assert.ok(!allow(policy, url), url);
});

test("IPv4-mapped IPv6 preserves the embedded IPv4 classification", () => {
  const policy = strict();
  for (const url of [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
  ])
    assert.ok(!allow(policy, url), url);
  assert.ok(allow(policy, "https://[::ffff:8.8.8.8]/"));
});

test("metadata stays blocked even with the default open posture", () => {
  const policy = new NetworkPolicy();
  assert.ok(!allow(policy, "http://169.254.169.254/latest/meta-data/"));
  assert.ok(!allow(policy, "http://[::ffff:169.254.169.254]/"));
  assert.ok(!allow(policy, "http://metadata.google.internal/"));
});

test("loopback opt-in does not open the private network", () => {
  const policy = new NetworkPolicy({
    allowPrivateNetwork: false,
    allowLoopback: true,
  });
  assert.ok(allow(policy, "http://127.0.0.1:3000/"));
  assert.ok(allow(policy, "http://localhost:3000/"));
  assert.ok(!allow(policy, "http://10.0.0.1/"));
});

test("block host beats defaults and matches subdomains", () => {
  const policy = new NetworkPolicy({ blockHosts: ["ads.example.com"] });
  assert.ok(!allow(policy, "https://ads.example.com/pixel"));
  assert.ok(!allow(policy, "https://tracker.ads.example.com/"));
  assert.ok(allow(policy, "https://example.com/"));
});

test("allow host honors an explicit port", () => {
  const policy = new NetworkPolicy({
    allowPrivateNetwork: false,
    allowLoopback: false,
    allowHosts: ["localhost:3000"],
  });
  assert.ok(allow(policy, "http://localhost:3000/"));
  assert.ok(!allow(policy, "http://localhost:4000/"));
});

test("urls with token-shaped query strings are allowed", () => {
  const policy = new NetworkPolicy();
  assert.ok(allow(policy, `https://evil.example.com/?t=ghp_${"a".repeat(36)}`));
  assert.ok(
    allow(policy, "https://example.com/?key=sk-abcdefghijklmnopqrstuvwxyz123456"),
  );
});

test("unsupported schemes blocked, data/blank allowed", () => {
  const policy = new NetworkPolicy();
  assert.ok(!allow(policy, "file:///etc/passwd"));
  assert.ok(allow(policy, "about:blank"));
  assert.ok(allow(policy, "data:text/html,<p>hi</p>"));
});

test("custom hook overrides the decision", () => {
  const policy = new NetworkPolicy({ custom: () => ({ allowed: false, reason: "custom" }) });
  assert.ok(!allow(policy, "https://example.com/"));
});
