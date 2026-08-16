import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertRotationPreservesMatchMode,
  pendingCredentialRecovery,
} from "../../dist/src/credential-constants.js";
import { BetterWright, LocalCredentialVault } from "../../dist/src/index.js";
import { NetworkPolicy } from "../../dist/src/policy.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("the encrypted local credential vault is enabled by default and can be replaced or disabled", async () => {
  const home = path.join(os.tmpdir(), "betterwright-client-default-vault");
  const local = new BetterWright({ home });
  const customVault = { async handleRequest() {} };
  const custom = new BetterWright({ vault: customVault });
  const disabled = new BetterWright({ vault: false });
  const disabledWithNull = new BetterWright({ vault: null });
  try {
    assert.ok(local.vault instanceof LocalCredentialVault);
    assert.equal(local.vault.dir, path.join(home, "vault"));
    assert.equal(custom.vault, customVault);
    assert.equal(disabled.vault, null);
    assert.equal(disabledWithNull.vault, null);
    assert.throws(
      () => new BetterWright({ vault: true }),
      /vault must implement handleRequest/,
    );
  } finally {
    await local.close();
    await custom.close();
    await disabled.close();
    await disabledWithNull.close();
  }
});

test("download approval is required by default and configurable", async () => {
  const guarded = new BetterWright();
  const allowed = new BetterWright({ downloadPolicy: "allow" });
  try {
    assert.equal(guarded.downloadPolicy, "ask");
    assert.equal(guarded._workerConfig().downloadPolicy, "ask");
    assert.equal(allowed.downloadPolicy, "allow");
    assert.throws(
      () => new BetterWright({ downloadPolicy: "sometimes" }),
      /downloadPolicy must be "ask", "allow", or "deny"/,
    );
  } finally {
    await guarded.close();
    await allowed.close();
  }
});

test("public search result UIs are allowed by default and block is opt-in", async () => {
  const relaxed = new BetterWright();
  const blocked = new BetterWright({ publicSearchPolicy: "block" });
  try {
    assert.equal(relaxed.publicSearchPolicy, "allow");
    assert.equal(relaxed._workerConfig().publicSearchPolicy, "allow");
    assert.equal(blocked._workerConfig().publicSearchPolicy, "block");
    assert.throws(
      () => new BetterWright({ publicSearchPolicy: "pace" }),
      /publicSearchPolicy must be "block" or "allow"/,
    );
  } finally {
    await relaxed.close();
    await blocked.close();
  }
});

test("the managed browser family remains the public default", async () => {
  const browser = new BetterWright();
  try {
    assert.equal(browser.browserFlavor, "chromium-fork");
    assert.equal(browser._workerConfig().browserFlavor, "chromium-fork");
    assert.equal(browser.provider, null);
  } finally {
    await browser.close();
  }
});

test("launch-identity options reach the worker and headedInvisible forces headed mode", async () => {
  const defaults = new BetterWright();
  const configured = new BetterWright({
    launchIdentity: false,
    upstreamProxy: "socks5://proxy.example:1080",
    geoip: true,
    locale: "de-DE",
    timezone: "Europe/Berlin",
    headless: true,
    headedInvisible: true,
  });
  try {
    assert.equal(defaults.launchIdentity, true);
    assert.equal(defaults._workerConfig().launchIdentity, true);
    assert.equal(configured.headless, false);
    assert.deepEqual(
      {
        launchIdentity: configured._workerConfig().launchIdentity,
        upstreamProxy: configured._workerConfig().upstreamProxy,
        geoip: configured._workerConfig().geoip,
        locale: configured._workerConfig().locale,
        timezone: configured._workerConfig().timezone,
        headedInvisible: configured._workerConfig().headedInvisible,
      },
      {
        launchIdentity: false,
        upstreamProxy: "socks5://proxy.example:1080",
        geoip: true,
        locale: "de-DE",
        timezone: "Europe/Berlin",
        headedInvisible: true,
      },
    );
  } finally {
    await defaults.close();
    await configured.close();
  }
});

test("provider options reach the worker config verbatim", async () => {
  const cdp = new BetterWright({ provider: { cdpUrl: "wss://browser.example.com" } });
  const cloud = new BetterWright({
    provider: { provider: "browserbase", apiKey: "bb_test", sessionOptions: { proxies: true } },
  });
  const env = new BetterWright();
  const previous = process.env.BETTERWRIGHT_CDP_URL;
  process.env.BETTERWRIGHT_CDP_URL = "wss://env.example.com";
  const fromEnv = new BetterWright();
  try {
    assert.deepEqual(cdp.provider, { cdpUrl: "wss://browser.example.com" });
    assert.deepEqual(cdp._workerConfig().provider, {
      cdpUrl: "wss://browser.example.com",
    });
    assert.deepEqual(cloud._workerConfig().provider, {
      provider: "browserbase",
      apiKey: "bb_test",
      sessionOptions: { proxies: true },
    });
    assert.deepEqual(fromEnv.provider, { cdpUrl: "wss://env.example.com" });
    assert.equal(env.provider, null);
    // The stealth/provider conflict fires when the worker starts.
    await assert.rejects(
      () =>
        new BetterWright({
          provider: { provider: "kernel" },
          stealthRuntimeFix: true,
        }).run("return 1;"),
      /stealthRuntimeFix applies only/,
    );
  } finally {
    if (previous === undefined) delete process.env.BETTERWRIGHT_CDP_URL;
    else process.env.BETTERWRIGHT_CDP_URL = previous;
    await cdp.close();
    await cloud.close();
    await env.close();
    await fromEnv.close();
  }
});

test("chromiumArgs reach the worker config and only security-sensitive switches fail", async () => {
  const defaults = new BetterWright();
  const tuned = new BetterWright({
    chromiumArgs: ["--disable-gpu", "--disk-cache-size=1"],
  });
  try {
    assert.deepEqual(defaults.chromiumArgs, []);
    assert.deepEqual(defaults._workerConfig().chromiumArgs, []);
    assert.deepEqual(tuned._workerConfig().chromiumArgs, [
      "--disable-gpu",
      "--disk-cache-size=1",
    ]);
    // Rejected in the constructor, so a switch that would bypass the guard
    // proxy surfaces as a clear TypeError instead of an opaque launch failure.
    assert.throws(
      () => new BetterWright({ chromiumArgs: ["--proxy-server=http://10.0.0.1:8080"] }),
      { name: "TypeError", message: /reserved by BetterWright/ },
    );
    const compatible = new BetterWright({
      chromiumArgs: ["--disable-software-rasterizer"],
    });
    assert.deepEqual(compatible._workerConfig().chromiumArgs, [
      "--disable-software-rasterizer",
    ]);
    await compatible.close();
  } finally {
    await defaults.close();
    await tuned.close();
  }
});

test("headed and headless modes use the same managed profile", async () => {
  const headed = new BetterWright({ headless: false });
  const headless = new BetterWright({ headless: true });
  try {
    assert.equal(headed.browserFlavor, "chromium-fork");
    assert.equal(headless.browserFlavor, "chromium-fork");
    assert.equal(headed.headless, false);
    assert.equal(headless.headless, true);
    assert.match(headed._workerConfig().profileDir, /[/\\]profile$/);
    assert.equal(
      headed._workerConfig().profileDir,
      headless._workerConfig().profileDir,
    );
  } finally {
    await headed.close();
    await headless.close();
  }
});

test("legacy browser toggles are rejected with the provider migration path", () => {
  const saved = {
    BETTERWRIGHT_BROWSER: process.env.BETTERWRIGHT_BROWSER,
    CLOAKBROWSER_BINARY_PATH: process.env.CLOAKBROWSER_BINARY_PATH,
  };
  try {
    process.env.BETTERWRIGHT_BROWSER = "cloak";
    assert.throws(() => new BetterWright(), /no longer exists/);
    process.env.BETTERWRIGHT_BROWSER = "chromium";
    assert.throws(() => new BetterWright(), /no longer exists/);
    delete process.env.BETTERWRIGHT_BROWSER;
    process.env.CLOAKBROWSER_BINARY_PATH = "/opt/cloak/chrome";
    assert.throws(
      () => new BetterWright(),
      /CLOAKBROWSER_BINARY_PATH has no effect/,
    );
    delete process.env.CLOAKBROWSER_BINARY_PATH;
    // The managed fork is the default once the legacy toggles are gone.
    const browser = new BetterWright();
    assert.equal(browser.browserFlavor, "chromium-fork");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("pendingCredentialRecovery requires a pendingId and stringifies the origin", () => {
  assert.equal(pendingCredentialRecovery(null, {}, "https://a.test"), null);
  assert.equal(pendingCredentialRecovery({}, {}, "https://a.test"), null);
  assert.equal(
    pendingCredentialRecovery({ pendingId: "   " }, {}, "https://a.test"),
    null,
  );
  assert.deepEqual(
    pendingCredentialRecovery(
      { pendingId: " pending_1 " },
      null,
      new URL("https://signup.example.test"),
    ),
    {
      pendingId: "pending_1",
      origin: "https://signup.example.test/",
      matchMode: "base-domain",
      username: null,
      label: null,
      expiresAt: null,
    },
  );
});

test("pendingCredentialRecovery matchMode: record wins, then request, then base-domain", () => {
  const at = (record, requested) =>
    pendingCredentialRecovery(
      { pendingId: "p", ...record },
      requested,
      "https://a.test",
    ).matchMode;
  assert.equal(at({ matchMode: "exact-origin" }, { matchMode: "host" }), "exact-origin");
  assert.equal(at({ matchMode: "never" }, {}), "never");
  assert.equal(at({ matchMode: "bogus" }, { matchMode: "host" }), "host");
  assert.equal(at({}, { matchMode: "host" }), "host");
  assert.equal(at({ matchMode: "bogus" }, { matchMode: "also-bogus" }), "base-domain");
  assert.equal(at({}, {}), "base-domain");
  assert.equal(at({}, null), "base-domain");
});

test("pendingCredentialRecovery resolves username/label by own-property, honoring explicit null", () => {
  const build = (record, requested) =>
    pendingCredentialRecovery(
      { pendingId: "p", ...record },
      requested,
      "https://a.test",
    );
  // The record's own property wins even when its value is null.
  assert.equal(
    build({ username: null }, { username: "alice@example.test" }).username,
    null,
  );
  assert.equal(build({ label: null }, { label: "work" }).label, null);
  // Absent from the record: fall back to the request, stringified.
  assert.equal(
    build({}, { username: "alice@example.test" }).username,
    "alice@example.test",
  );
  assert.equal(build({}, { username: 42 }).username, "42");
  assert.equal(build({}, { label: "work" }).label, "work");
  // Present on the record: the record value wins, stringified.
  assert.equal(build({ username: 7 }, { username: "alice" }).username, "7");
  // Absent everywhere: null.
  assert.equal(build({}, {}).username, null);
  assert.equal(build({}, {}).label, null);
});

test("pendingCredentialRecovery expiresAt is null unless the record carries a value", () => {
  const build = (record) =>
    pendingCredentialRecovery({ pendingId: "p", ...record }, {}, "https://a.test");
  assert.equal(build({}).expiresAt, null);
  assert.equal(build({ expiresAt: null }).expiresAt, null);
  assert.equal(
    build({ expiresAt: "2026-08-01T00:00:00.000Z" }).expiresAt,
    "2026-08-01T00:00:00.000Z",
  );
  assert.equal(build({ expiresAt: 0 }).expiresAt, "0");
});

test("rotating an existing credential rejects a matchMode override everywhere", () => {
  const expected =
    /matchMode cannot be changed when rotating an existing credential/;
  assert.throws(
    () => assertRotationPreservesMatchMode({ id: "cred_1", matchMode: "host" }),
    (error) => error instanceof TypeError && expected.test(error.message),
  );
  assert.throws(
    () => assertRotationPreservesMatchMode({ id: 0, matchMode: null }),
    TypeError,
  );
  assert.doesNotThrow(() => assertRotationPreservesMatchMode({ id: "cred_1" }));
  assert.doesNotThrow(() =>
    assertRotationPreservesMatchMode({ matchMode: "host" }),
  );
  assert.doesNotThrow(() =>
    assertRotationPreservesMatchMode({ id: null, matchMode: "host" }),
  );
  assert.doesNotThrow(() => assertRotationPreservesMatchMode(undefined));
  assert.doesNotThrow(() => assertRotationPreservesMatchMode(null));
});

// Regression: a launch step failing after the browser context was already
// launched (here: the download guard, which requires a browser CDP session the
// stub driver does not provide) must close that context — before the profile
// lock is released — instead of orphaning the Chromium process.
test("a failed launch step closes the already-launched browser context", async (t) => {
  const home = makeTempDir("betterwright-launch-leak-");
  const stubBinary = makeTempDir("betterwright-provider-stub-");
  const marker = path.join(stubBinary, "close-marker.jsonl");
  // The driver stub replaces playwright-core in the worker so the launch path
  // runs without a real Chromium.
  const driverRoot = makeTempDir("betterwright-driver-stub-");
  fs.mkdirSync(path.join(driverRoot, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(driverRoot, "package.json"),
    JSON.stringify({
      name: "playwright-core",
      version: "1.61.1",
      type: "module",
      exports: { ".": "./lib/index.js" },
    }),
  );
  fs.writeFileSync(
    path.join(driverRoot, "lib", "index.js"),
    `export const chromium = {
  async launchPersistentContext(userDataDir) {
    const fs = await import("node:fs");
    const { EventEmitter } = await import("node:events");
    const emitter = new EventEmitter();
    const lockDir = \`\${userDataDir}.betterwright-lock\`;
    const marker = process.env.BETTERWRIGHT_TEST_CLOSE_MARKER;
    return {
      on: (...args) => emitter.on(...args),
      once: (...args) => emitter.once(...args),
      async route() {},
      // No newBrowserCDPSession: installDownloadGuard must fail after launch.
      browser: () => ({}),
      pages: () => [],
      async close() {
        fs.appendFileSync(
          marker,
          \`\${JSON.stringify({ lockHeldAtClose: fs.existsSync(lockDir) })}\\n\`,
        );
        emitter.emit("close");
      },
    };
  },
};
`,
  );
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of [
    "BETTERWRIGHT_PLAYWRIGHT_CORE_PATH",
    "BETTERWRIGHT_TEST_CLOSE_MARKER",
  ])
    savedEnv[key] = process.env[key];
  process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH = driverRoot;
  process.env.BETTERWRIGHT_TEST_CLOSE_MARKER = marker;
  const binary = path.join(stubBinary, "chrome");
  fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  const browser = new BetterWright({
    home,
    provider: { executablePath: binary },
    headless: false,
    vault: false,
  });
  t.after(async () => {
    await browser.close().catch(() => {});
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(stubBinary, { recursive: true, force: true });
    fs.rmSync(driverRoot, { recursive: true, force: true });
  });

  const result = await browser.run("return 1;", { timeout: 30 });
  assert.equal(result.ok, false);
  assert.match(result.error, /browser CDP session/);
  assert.ok(
    fs.existsSync(marker),
    "the context launched before the failure was never closed (leaked browser)",
  );
  const closes = fs
    .readFileSync(marker, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(closes.length, 1, "the launched context must be closed exactly once");
  assert.equal(
    closes[0].lockHeldAtClose,
    true,
    "the context must be closed before the profile lock is released",
  );
});

test("only a stock NetworkPolicy's guard decisions are marked cacheable", async () => {
  // The worker caches a guard decision only when the client says it may, and
  // the client may only say so for the one policy shape whose verdict depends
  // on nothing but scheme, host, and port. Anything that can consult `details`,
  // time, or external state — a custom hook, a subclass, a duck-typed object —
  // must reach the policy on every request.
  class TighterPolicy extends NetworkPolicy {}
  const shared = Object.freeze({ allowed: true, reason: "shared verdict" });
  const patchedCheck = new NetworkPolicy();
  patchedCheck.check = () => shared;
  const grafted = Object.create(NetworkPolicy.prototype);
  grafted.custom = null;
  grafted.check = () => shared;
  const proxied = new Proxy(new NetworkPolicy(), {
    // NetworkPolicy has no accessor properties, so plain property access
    // forwards identically to a receiver-forwarding Reflect.get here.
    get: (target, prop) => (prop === "check" ? () => shared : target[prop]),
  });
  const cases = [
    { name: "default policy", options: {}, cacheable: true },
    { name: "stock NetworkPolicy", options: { policy: new NetworkPolicy() }, cacheable: true },
    {
      name: "custom hook",
      options: { policy: new NetworkPolicy({ custom: () => shared }) },
      cacheable: false,
    },
    { name: "subclass", options: { policy: new TighterPolicy() }, cacheable: false },
    {
      name: "duck-typed check",
      options: { policy: { check: () => shared } },
      cacheable: false,
    },
    // Exact-constructor identity alone would pass all three of these: an own
    // property shadows the prototype's check, and a Proxy forwards constructor
    // and custom to its target while intercepting check.
    { name: "instance-patched check", options: { policy: patchedCheck }, cacheable: false },
    { name: "grafted prototype", options: { policy: grafted }, cacheable: false },
    { name: "proxy decorator", options: { policy: proxied }, cacheable: false },
  ];

  for (const item of cases) {
    const bw = new BetterWright({ vault: false, ...item.options });
    const sent = [];
    bw._send = (message) => sent.push(message);
    try {
      assert.equal(bw._policyCacheable, item.cacheable, item.name);
      await bw._serviceRpc({
        requestId: "guard-1",
        method: "guard",
        payload: { url: "https://example.com/a", resourceType: "image", fullUrl: false },
      });
      const response = sent.at(-1);
      assert.equal(response.ok, true, item.name);
      assert.equal(response.result.cacheable, item.cacheable, item.name);
      assert.equal(response.result.allowed, true, item.name);
    } finally {
      await bw.close();
    }
  }
  // Annotating the decision must never write through to the policy's own object.
  assert.deepEqual(shared, { allowed: true, reason: "shared verdict" });
  assert.equal("cacheable" in shared, false);
});

test("cacheability follows mid-session policy mutation, not construction", async () => {
  // `policy`, `policy.custom`, and `policy.check` are all public and mutable,
  // and docs/network-policy.md advertises mid-session policy edits. A hook
  // installed after construction must stop the worker caching immediately —
  // memoizing the flag would keep serving pre-hook verdicts for up to the cache
  // TTL, and forever for hosts that keep being refreshed as cacheable.
  const guard = async (bw) => {
    const sent = [];
    bw._send = (message) => sent.push(message);
    await bw._serviceRpc({
      requestId: "guard-1",
      method: "guard",
      payload: { url: "https://example.com/a", resourceType: "image", fullUrl: false },
    });
    return sent.at(-1).result;
  };

  const policy = new NetworkPolicy();
  const bw = new BetterWright({ vault: false, policy });
  try {
    assert.equal((await guard(bw)).cacheable, true);

    policy.custom = () => ({ allowed: false, reason: "hook says no" });
    const hooked = await guard(bw);
    assert.equal(hooked.cacheable, false);
    assert.equal(hooked.allowed, false);

    policy.custom = null;
    assert.equal((await guard(bw)).cacheable, true);

    policy.check = () => ({ allowed: true, reason: "patched" });
    assert.equal((await guard(bw)).cacheable, false);

    bw.policy = new NetworkPolicy();
    assert.equal((await guard(bw)).cacheable, true);

    bw.policy = new NetworkPolicy({ custom: () => ({ allowed: true, reason: "swapped" }) });
    assert.equal((await guard(bw)).cacheable, false);
  } finally {
    await bw.close();
  }
});
