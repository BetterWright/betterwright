// The worker's guard entrypoint and its decision cache. The cache is the one
// place a network decision is reused instead of re-derived, so these tests pin
// the security contract in src/guard-url.ts: only the client may declare a
// decision cacheable, only host-scoped checks are eligible, failures are never
// cached, and a cached answer is byte-identical to the one the policy would
// have produced for that URL.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGuardUrl } from "../../dist/src/guard-url.js";
import { BetterWright } from "../../dist/src/index.js";
import { NetworkPolicy } from "../../dist/src/policy.js";

const ALLOWED = { allowed: true, cacheable: true };

function recordingRpc(respond: (payload?: any, call?: number) => any = () => ALLOWED) {
  const calls = [];
  const rpc = async (method, payload, executeId) => {
    calls.push({ method, payload, executeId });
    const response = respond(payload, calls.length);
    if (response instanceof Error) throw response;
    return response;
  };
  return { rpc, calls };
}

// One BetterWright is the real client half of the guard RPC: the decision and
// the `cacheable` flag both come from the shipped code path, not a stand-in.
function clientGuard(policy, options: any = {}) {
  const bw = new BetterWright({ policy, vault: false });
  const sent = [];
  let calls = 0;
  bw._send = (message) => sent.push(message);
  const rpc = async (method, payload, executeId) => {
    calls += 1;
    const requestId = `guard-${calls}`;
    await bw._serviceRpc({ requestId, method, payload, id: executeId });
    const response = sent.at(-1);
    assert.equal(response.requestId, requestId);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  return {
    bw,
    guardUrl: createGuardUrl({ rpc, ...options }),
    rpcCount: () => calls,
  };
}

test("a cacheable decision answers later checks for the same scheme, host, and port", async () => {
  const { rpc, calls } = recordingRpc();
  const guardUrl = createGuardUrl({ rpc });

  assert.deepEqual(await guardUrl("https://example.com/a", {}, "e1"), ALLOWED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "guard");
  assert.equal(calls[0].payload.fullUrl, false);

  // Path, query, and details vary; the decision does not.
  for (const url of [
    "https://example.com/b?q=1",
    "https://example.com/c#hash",
    "https://EXAMPLE.COM/d",
    "https://example.com:443/e",
  ])
    assert.equal((await guardUrl(url, { resourceType: "image" }, "e1")).allowed, true);
  assert.equal(calls.length, 1, "same origin must not re-ask the client");

  // A different scheme, host, or port is a different key.
  for (const url of [
    "http://example.com/a",
    "https://other.example.com/a",
    "https://example.com:8443/a",
  ])
    assert.equal((await guardUrl(url, {}, "e1")).allowed, true);
  assert.equal(calls.length, 4);
});

test("only the client's literal cacheable:true is ever cached", async () => {
  for (const cacheable of [undefined, false, null, 0, 1, "true", {}]) {
    const { rpc, calls } = recordingRpc(() =>
      cacheable === undefined ? { allowed: true } : { allowed: true, cacheable },
    );
    const guardUrl = createGuardUrl({ rpc });
    for (let attempt = 0; attempt < 3; attempt += 1)
      assert.equal((await guardUrl("https://example.com/", {}, "e1")).allowed, true);
    assert.equal(
      calls.length,
      3,
      `cacheable=${JSON.stringify(cacheable)} must not enable caching`,
    );
  }
});

test("a malformed or empty response is neither trusted nor cached", async () => {
  for (const response of [null, undefined, "allowed", { cacheable: true }]) {
    const { rpc, calls } = recordingRpc(() => response);
    const guardUrl = createGuardUrl({ rpc });
    const first = await guardUrl("https://example.com/", {}, "e1");
    assert.notEqual(first?.allowed, true, "a malformed response must not allow");
    await guardUrl("https://example.com/", {}, "e1");
    // `{cacheable: true}` is cacheable by contract, but it caches a denial.
    if (response && (response as any).cacheable === true) {
      assert.equal(calls.length, 1);
      assert.equal((await guardUrl("https://example.com/", {}, "e1")).allowed, false);
    } else assert.equal(calls.length, 2);
  }
});

test("denials are cached with their reason, and a cache hit cannot be mutated", async () => {
  const denial = {
    allowed: false,
    reason: "host blocked by policy: example.com",
    cacheable: true,
  };
  const { rpc, calls } = recordingRpc(() => denial);
  const guardUrl = createGuardUrl({ rpc });

  const first = await guardUrl("https://example.com/a", {}, "e1");
  assert.equal(first.allowed, false);
  const second: any = await guardUrl("https://example.com/b", {}, "e1");
  assert.equal(calls.length, 1, "denials are cached too");
  assert.deepEqual(second, { allowed: false, reason: denial.reason });

  second.allowed = true;
  second.reason = "tampered";
  const third = await guardUrl("https://example.com/c", {}, "e1");
  assert.deepEqual(third, { allowed: false, reason: denial.reason });
  assert.equal(calls.length, 1);
});

test("a failed guard denies the request and leaves nothing cached", async () => {
  const { rpc, calls } = recordingRpc((_payload, call) =>
    call === 1 ? new Error("worker pipe closed") : ALLOWED,
  );
  const guardUrl = createGuardUrl({ rpc });

  await assert.rejects(
    () => guardUrl("https://example.com/a", {}, "e1"),
    /worker pipe closed/,
    "an RPC failure must propagate so the transport fails closed",
  );
  assert.equal((await guardUrl("https://example.com/a", {}, "e1")).allowed, true);
  assert.equal(calls.length, 2, "the failed attempt must not have been cached");
});

test("full-URL checks never read or write the cache", async () => {
  const fullUrlCases = [
    { url: "https://example.com/page", details: { isNavigation: true } },
    { url: "https://example.com/page", details: { resourceType: "document" } },
    { url: "https://example.com/file.zip", details: { resourceType: "download" } },
    { url: "wss://example.com/socket", details: {} },
    { url: "ws://example.com/socket", details: {} },
  ];
  for (const { url, details } of fullUrlCases) {
    const { rpc, calls } = recordingRpc();
    const guardUrl = createGuardUrl({ rpc });
    for (let attempt = 0; attempt < 3; attempt += 1) await guardUrl(url, details, "e1");
    assert.equal(calls.length, 3, `${url} ${JSON.stringify(details)} must not be cached`);
    assert.ok(calls.every((call) => call.payload.fullUrl === true));
  }

  // Nor may the two kinds answer for each other in either direction.
  const subresourceFirst = recordingRpc();
  const subresourceGuard = createGuardUrl({ rpc: subresourceFirst.rpc });
  await subresourceGuard("https://example.com/img.png", { resourceType: "image" }, "e1");
  await subresourceGuard("https://example.com/page", { isNavigation: true }, "e1");
  assert.equal(subresourceFirst.calls.length, 2);

  const navigationFirst = recordingRpc();
  const navigationGuard = createGuardUrl({ rpc: navigationFirst.rpc });
  await navigationGuard("https://example.com/page", { isNavigation: true }, "e1");
  await navigationGuard("https://example.com/img.png", { resourceType: "image" }, "e1");
  assert.equal(navigationFirst.calls.length, 2);
});

test("cached entries expire at the TTL", async () => {
  let clock = 1_000;
  const { rpc, calls } = recordingRpc();
  const guardUrl = createGuardUrl({ rpc, now: () => clock, ttlMs: 5_000 });

  await guardUrl("https://example.com/", {}, "e1");
  clock += 5_000;
  await guardUrl("https://example.com/", {}, "e1");
  assert.equal(calls.length, 1, "an entry is live through the whole TTL");
  clock += 1;
  await guardUrl("https://example.com/", {}, "e1");
  assert.equal(calls.length, 2, "an expired entry must re-ask the client");
  // The refreshed entry starts a new TTL rather than inheriting the old one.
  clock += 5_000;
  await guardUrl("https://example.com/", {}, "e1");
  assert.equal(calls.length, 2);
});

test("a policy change is picked up once the entry expires", async () => {
  let clock = 0;
  const policy = new NetworkPolicy({ allowPrivateNetwork: false, allowLoopback: false });
  const { bw, guardUrl, rpcCount } = clientGuard(policy, { now: () => clock, ttlMs: 5_000 });
  try {
    assert.equal((await guardUrl("https://blocked.example/a", {}, "e1")).allowed, true);
    policy.blockHosts.push("blocked.example");
    assert.equal(
      (await guardUrl("https://blocked.example/b", {}, "e1")).allowed,
      true,
      "the documented cost of caching: a mutation is invisible until the TTL",
    );
    assert.equal(rpcCount(), 1);

    clock += 5_001;
    const decision = await guardUrl("https://blocked.example/c", {}, "e1");
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /blocked by policy/);
    assert.equal(rpcCount(), 2);
  } finally {
    await bw.close();
  }
});

test("the cache is bounded and evicts the oldest entry first", async () => {
  const { rpc, calls } = recordingRpc();
  const guardUrl = createGuardUrl({ rpc, max: 3 });

  for (const host of ["a", "b", "c"]) await guardUrl(`https://${host}.example/`, {}, "e1");
  assert.equal(calls.length, 3);
  // A hit at capacity evicts nothing.
  await guardUrl("https://c.example/again", {}, "e1");
  assert.equal(calls.length, 3);

  // Eviction is by insertion order, not by use: a hit does not move an entry.
  await guardUrl("https://d.example/", {}, "e1");
  assert.equal(calls.length, 4);
  for (const host of ["b", "c", "d"]) await guardUrl(`https://${host}.example/`, {}, "e1");
  assert.equal(calls.length, 4, "newer entries must have survived");
  await guardUrl("https://a.example/", {}, "e1");
  assert.equal(calls.length, 5, "the oldest entry must have been evicted");
});

test("non-network URLs are decided without an RPC", async () => {
  const { rpc, calls } = recordingRpc();
  const guardUrl = createGuardUrl({ rpc });

  assert.deepEqual(await guardUrl("about:blank", {}, "e1"), { allowed: true });
  assert.deepEqual(await guardUrl("data:text/html,hi", {}, "e1"), { allowed: true });
  assert.deepEqual(await guardUrl("blob:https://example.com/x", {}, "e1"), {
    allowed: true,
  });
  assert.equal((await guardUrl("file:///etc/passwd", {}, "e1")).allowed, false);
  assert.equal((await guardUrl("javascript:alert(1)", {}, "e1")).allowed, false);
  assert.deepEqual(await guardUrl("not a url", {}, "e1"), {
    allowed: false,
    reason: "invalid URL",
  });
  assert.equal(calls.length, 0);
});

// --- Differential: the cache must never change a decision ------------------

const vectorsPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "policy-vectors.json",
);
const { vectors } = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));

function policyOptions(snakeCase) {
  return {
    allowPrivateNetwork: snakeCase.allow_private_network,
    allowLoopback: snakeCase.allow_loopback,
    allowHosts: snakeCase.allow_hosts,
    blockHosts: snakeCase.block_hosts,
  };
}

const CACHEABLE_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

function cacheEligible(url) {
  try {
    return CACHEABLE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

test("a cached guard decides every URL exactly as NetworkPolicy.check does", async () => {
  // Deterministic PRNG: a failure here must be reproducible.
  let seed = 0x51f3a7d;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];

  const hosts = [
    ...new Set(
      vectors
        .filter((vector) => cacheEligible(vector.url))
        .map((vector) => new URL(vector.url).hostname),
    ),
    "example.com",
    "sub.example.com",
    "notexample.com",
    "127.0.0.1",
    "169.254.169.254",
    "10.1.2.3",
    "[::1]",
    "metadata.google.internal",
  ];
  const schemes = ["http:", "https:", "ws:", "wss:"];
  const ports = ["", ":80", ":443", ":8080", ":8443"];
  const paths = ["/", "/a", "/b?q=1", "/deep/path#frag"];
  const detailSets = [
    {},
    { resourceType: "image" },
    { resourceType: "xhr", method: "POST" },
    { resourceType: "document" },
    { resourceType: "download" },
    { isNavigation: true },
  ];

  // Group by policy so each guard instance sees one policy, exactly as a worker
  // process does.
  const groups = new Map();
  for (const vector of vectors) {
    const key = JSON.stringify(vector.policy);
    if (!groups.has(key)) groups.set(key, { options: policyOptions(vector.policy), urls: [] });
    groups.get(key).urls.push(vector.url);
  }

  for (const [key, group] of groups) {
    const reference = new NetworkPolicy(group.options);
    const cached = clientGuard(new NetworkPolicy(group.options));
    // Same client, same policy, caching disabled: the control arm.
    const uncached = clientGuard(new NetworkPolicy(group.options), { ttlMs: -1 });
    try {
      // Only the schemes the guard forwards to the policy: about:/data:/blob:
      // and unsupported schemes are decided in the worker before any RPC, and
      // are covered by their own test above.
      const stream = group.urls.filter(cacheEligible);
      for (let index = 0; index < 200; index += 1)
        stream.push(`${pick(schemes)}//${pick(hosts)}${pick(ports)}${pick(paths)}`);
      // Revisit earlier URLs so the stream actually exercises hits.
      for (let index = 0; index < 100; index += 1) stream.push(pick(stream));

      for (const url of stream) {
        const details = pick(detailSets);
        const expected = reference.check(url, details);
        for (const [name, arm] of [
          ["cached", cached],
          ["uncached", uncached],
        ] as const) {
          const actual: any = await arm.guardUrl(url, details, "diff");
          assert.equal(
            Boolean(actual?.allowed),
            Boolean(expected.allowed),
            `${name} ${key} ${url} ${JSON.stringify(details)}`,
          );
          assert.equal(
            actual?.reason,
            expected.reason,
            `${name} ${key} ${url} ${JSON.stringify(details)}`,
          );
        }
      }
      assert.ok(
        cached.rpcCount() < uncached.rpcCount(),
        "the cache must actually be saving round trips",
      );
    } finally {
      await cached.bw.close();
      await uncached.bw.close();
    }
  }
});

// A hook installed after the browser has already contacted a host is the case
// that made "a custom policy is never cached" untrue: refusing to write new
// entries still left the old ones answering. These pin the flush that fixes it,
// and the bound on what the flush cannot reach.

test("a custom hook installed mid-session governs hosts already cached", async () => {
  // The clock never advances, so nothing here can be the TTL doing the work.
  const clock = 0;
  const policy = new NetworkPolicy();
  const { bw, guardUrl, rpcCount } = clientGuard(policy, { now: () => clock, ttlMs: 5_000 });
  try {
    assert.equal((await guardUrl("https://seen.example/a", {}, "e1")).allowed, true);
    assert.equal((await guardUrl("https://seen.example/b", {}, "e1")).allowed, true);
    assert.equal(rpcCount(), 1, "the second check was served from the cache");

    policy.custom = () => ({ allowed: false, reason: "custom deny" });

    // Any navigation is an uncacheable check, so it reaches the client, comes
    // back not-cacheable, and empties the cache.
    const navigation = await guardUrl(
      "https://elsewhere.example/page",
      { isNavigation: true },
      "e1",
    );
    assert.equal(navigation.allowed, false);

    const revisited = await guardUrl("https://seen.example/c", {}, "e1");
    assert.equal(revisited.allowed, false, "the hook now decides the cached host");
    assert.match(revisited.reason, /custom deny/);
  } finally {
    await bw.close();
  }
});

test("an uncacheable response empties the cache even for an unrelated host", async () => {
  const clock = 0;
  const { rpc, calls } = recordingRpc((payload) =>
    payload.fullUrl ? { allowed: true } : { allowed: true, cacheable: true },
  );
  const guardUrl = createGuardUrl({ rpc, now: () => clock, ttlMs: 5_000 });

  await guardUrl("https://a.example/1", {}, "e1");
  await guardUrl("https://b.example/1", {}, "e1");
  assert.equal(calls.length, 2);
  await guardUrl("https://a.example/2", {}, "e1");
  assert.equal(calls.length, 2, "both hosts are cached");

  await guardUrl("https://c.example/page", { isNavigation: true }, "e1");
  assert.equal(calls.length, 3);

  await guardUrl("https://a.example/3", {}, "e1");
  await guardUrl("https://b.example/2", {}, "e1");
  assert.equal(calls.length, 5, "the flush dropped every entry, not just one");
});

test("a cacheable response never flushes: normal operation keeps its cache", async () => {
  // The flush must key off cacheability, not off the check being full-URL — a
  // stock policy answers navigations with cacheable:true, and a page load
  // interleaves those with subresources constantly.
  const clock = 0;
  const policy = new NetworkPolicy();
  const { bw, guardUrl, rpcCount } = clientGuard(policy, { now: () => clock, ttlMs: 5_000 });
  try {
    await guardUrl("https://keep.example/sub", {}, "e1");
    assert.equal(rpcCount(), 1);
    await guardUrl("https://keep.example/page", { isNavigation: true }, "e1");
    assert.equal(rpcCount(), 2, "navigations always reach the client");
    await guardUrl("https://keep.example/sub2", {}, "e1");
    assert.equal(rpcCount(), 2, "the host entry survived the navigation");
  } finally {
    await bw.close();
  }
});

test("without an uncacheable check in between, a new hook waits for the TTL", async () => {
  // The honest bound: the flush needs a response to ride on. A host re-checked
  // with nothing uncacheable in between converges on ttlMs, exactly like an
  // allowHosts/blockHosts mutation.
  let clock = 0;
  const policy = new NetworkPolicy();
  const { bw, guardUrl } = clientGuard(policy, { now: () => clock, ttlMs: 5_000 });
  try {
    assert.equal((await guardUrl("https://quiet.example/a", {}, "e1")).allowed, true);
    policy.custom = () => ({ allowed: false, reason: "custom deny" });
    assert.equal(
      (await guardUrl("https://quiet.example/b", {}, "e1")).allowed,
      true,
      "still stale: nothing has reached the client to carry the flush",
    );
    clock += 5_001;
    assert.equal((await guardUrl("https://quiet.example/c", {}, "e1")).allowed, false);
  } finally {
    await bw.close();
  }
});
