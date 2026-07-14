import assert from "node:assert/strict";
import { test } from "node:test";

import { NetworkPolicy } from "../../src/policy.mjs";

const allow = (policy, url) => policy.check(url).allowed === true;

test("public https allowed by default", () => {
  assert.ok(allow(new NetworkPolicy(), "https://example.com/path?q=1"));
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

test("private ranges blocked by default", () => {
  const policy = new NetworkPolicy();
  for (const url of [
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.9.9/",
    "http://127.0.0.1:8000/",
  ])
    assert.ok(!allow(policy, url), url);
});

test("IPv4-mapped IPv6 preserves the embedded IPv4 classification", () => {
  const policy = new NetworkPolicy();
  for (const url of [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
  ])
    assert.ok(!allow(policy, url), url);
  assert.ok(allow(policy, "https://[::ffff:8.8.8.8]/"));
});

test("loopback opt-in does not open the private network", () => {
  const policy = new NetworkPolicy({ allowLoopback: true });
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
  const policy = new NetworkPolicy({ allowHosts: ["localhost:3000"] });
  assert.ok(allow(policy, "http://localhost:3000/"));
  assert.ok(!allow(policy, "http://localhost:4000/"));
});

test("secret-bearing url blocked", () => {
  const policy = new NetworkPolicy();
  assert.ok(!allow(policy, `https://evil.example.com/?t=ghp_${"a".repeat(36)}`));
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
