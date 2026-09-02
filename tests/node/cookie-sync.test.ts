import assert from "node:assert/strict";
import test from "node:test";

import {
  COOKIE_SYNC_MAX_COOKIES,
  extractCookieSync,
  listCookieSourceBrowsers,
  listCookieSourceProfiles,
  normalizeCookieSnapshot,
  normalizeCookieSyncOptions,
  validateCookieSyncTargetCookies,
} from "../../dist/src/cookie-sync.js";

function detailed(cookie: any = {}, context: any = {}) {
  return {
    cookie: {
      domain: ".example.com",
      path: "/",
      secure: true,
      name: "session",
      value: "opaque-token",
      httpOnly: true,
      sameSite: 1,
      ...cookie,
    },
    context: {
      topFrameSiteKey: null,
      hasCrossSiteAncestor: null,
      sourceScheme: null,
      sourcePort: null,
      isPersistent: true,
      originAttributes: null,
      userContextId: null,
      partitionKey: null,
      privateBrowsingId: null,
      ...context,
    },
  };
}

function reader(snapshot: any, calls: any[] = []) {
  return {
    version: () => "0.6.0",
    read: async (options) => {
      calls.push(options);
      return snapshot;
    },
    supportedBrowsers: async () => [],
    browserProfiles: async () => [],
  };
}

test("Cookie Sync normalizes source, domains, timeout, and secure defaults", () => {
  const options = normalizeCookieSyncOptions({
    source: { browser: " Chrome " },
    domains: ["HTTPS://Bücher.example", "xn--bcher-kva.example"],
    timeoutMs: 999_999,
  });
  assert.deepEqual(options, {
    source: { browser: "chrome" },
    domains: ["xn--bcher-kva.example"],
    includeSession: false,
    windowsAppBound: "disabled",
    timeoutMs: 120_000,
  });
  assert.throws(
    () => normalizeCookieSyncOptions({ source: { browser: "chrome" }, domains: [] }),
    /non-empty array/,
  );
  assert.throws(
    () => normalizeCookieSyncOptions({ source: { browser: "chrome" }, domains: ["x.test/path"] }),
    /without paths/,
  );
  assert.throws(
    () => normalizeCookieSyncOptions({ source: { browser: "chrome" }, domains: ["ftp://x.test"] }),
    /without paths/,
  );
  assert.throws(
    () => normalizeCookieSyncOptions({ source: { browser: "chrome" }, windowsAppBound: "elevated" }),
    /disabled.*injection/,
  );
});

test("Cookie Sync keeps applicable parent cookies and faithful Chromium partitions", () => {
  const snapshot = {
    detailedCookies: [
      detailed({ name: "parent", domain: ".example.com", sameSite: 0 }),
      detailed({ name: "host-only-parent", domain: "example.com" }),
      detailed(
        { name: "partitioned", domain: "app.example.com", sameSite: 2 },
        { topFrameSiteKey: "https://top.example", hasCrossSiteAncestor: false },
      ),
      detailed({ name: "other", domain: ".unrelated.test" }),
    ],
    warnings: [],
  };
  const result = normalizeCookieSnapshot(
    snapshot,
    { source: { browser: "chrome" }, domains: ["app.example.com"] },
    { now: Date.UTC(2026, 0, 1) },
  );
  assert.deepEqual(
    result.cookies.map(({ name, sameSite, partitionKey, partitionCrossSiteAncestor }) => ({
      name,
      sameSite,
      partitionKey,
      partitionCrossSiteAncestor,
    })),
    [
      {
        name: "parent",
        sameSite: "None",
        partitionKey: undefined,
        partitionCrossSiteAncestor: undefined,
      },
      {
        name: "partitioned",
        sameSite: "Strict",
        partitionKey: "https://top.example",
        partitionCrossSiteAncestor: false,
      },
    ],
  );
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.warnings, [{ code: "domain_filtered", count: 2 }]);
});

test("Cookie Sync keeps IPv6 hosts and origin metadata on the winning target identity", () => {
  const result = normalizeCookieSnapshot(
    {
      detailedCookies: [
        detailed(
          { name: "local", domain: "[::1]", secure: false },
          { sourceScheme: 1, sourcePort: 8_080 },
        ),
        detailed(
          { name: "scoped", value: "port-a" },
          { sourceScheme: 2, sourcePort: 443 },
        ),
        detailed(
          { name: "scoped", value: "port-b" },
          { sourceScheme: 2, sourcePort: 8_443 },
        ),
      ],
      warnings: [],
    },
    { source: { browser: "chrome" }, domains: ["[::1]", "example.com"] },
  );
  assert.equal(result.cookies.length, 2);
  assert.deepEqual(result.cookies[0], {
    name: "local",
    value: "opaque-token",
    domain: "[::1]",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    sourceScheme: "NonSecure",
    sourcePort: 8_080,
  });
  assert.deepEqual(
    result.cookies.slice(1).map(({ value, sourceScheme, sourcePort }) => ({
      value,
      sourceScheme,
      sourcePort,
    })),
    [
      { value: "port-b", sourceScheme: "Secure", sourcePort: 8_443 },
    ],
  );
  assert.deepEqual(result.warnings, [{ code: "duplicate_replaced", count: 1 }]);
});

test("Cookie Sync drops expired, malformed, private, container, and Firefox-partitioned rows", () => {
  const now = Date.UTC(2026, 0, 1);
  const snapshot = {
    detailedCookies: [
      detailed({ name: "default-session" }, { originAttributes: "{}" }),
      detailed({ name: "expired", expires: now / 1000 - 1 }),
      detailed({ name: "bad-samesite", sameSite: 9 }),
      detailed({ name: "private" }, { privateBrowsingId: 1 }),
      detailed({ name: "container" }, { userContextId: 2, originAttributes: "^userContextId=2" }),
      detailed({ name: "firefox-partition" }, { partitionKey: "(https,example.com)" }),
      detailed({ name: "untyped-container" }, { userContextId: "2" }),
    ],
    warnings: [{ code: "locked row", count: 3, message: "must not be returned" }],
  };
  const result = normalizeCookieSnapshot(
    snapshot,
    { source: { browser: "firefox" } },
    { now },
  );
  assert.deepEqual(result.cookies.map(({ name }) => name), ["default-session"]);
  assert.equal(result.skipped, 6);
  assert.deepEqual(result.warnings, [
    { code: "locked_row", count: 3 },
    { code: "expired", count: 1 },
    { code: "malformed", count: 2 },
    { code: "unsupported_isolation", count: 3 },
  ]);
});

test("Cookie Sync replaces duplicate target identities and preserves separate CHIPS identities", () => {
  const result = normalizeCookieSnapshot(
    {
      detailedCookies: [
        detailed({ value: "old" }),
        detailed({ value: "new" }),
        detailed(
          { value: "partitioned" },
          { topFrameSiteKey: "https://top.example", hasCrossSiteAncestor: true },
        ),
      ],
      warnings: [],
    },
    { source: { browser: "chrome" } },
  );
  assert.equal(result.cookies.length, 2);
  assert.equal(result.cookies[0].value, "new");
  assert.equal(result.cookies[1].partitionCrossSiteAncestor, true);
  assert.deepEqual(result.warnings, [{ code: "duplicate_replaced", count: 1 }]);
});

test("Cookie Sync never enables elevated App-Bound recovery", async () => {
  const calls: any[] = [];
  const snapshot = { detailedCookies: [], warnings: [] };
  await extractCookieSync(
    normalizeCookieSyncOptions({ source: { browser: "chrome" } }),
    async () => reader(snapshot, calls),
  );
  await extractCookieSync(
    normalizeCookieSyncOptions({
      source: { browser: "chrome" },
      windowsAppBound: "injection",
    }),
    async () => reader(snapshot, calls),
  );
  assert.deepEqual(calls.map((call) => call.appBound), ["disabled", "injection_only"]);
  assert.equal(calls.some((call) => call.appBound === "allow_elevated_fallback"), false);
});

test("Cookie Sync accepts the pinned reader's build-suffixed version", async () => {
  const fake = reader({ detailedCookies: [], warnings: [] });
  fake.version = () => "0.6.0 (verified-build)";
  assert.deepEqual(await listCookieSourceBrowsers(async () => fake), []);
});

test("Cookie Sync discovery preserves unavailable-reader guidance", async () => {
  const unavailable = async () => {
    throw new Error(
      "Cookie Sync is unavailable on this host. Reinstall BetterWright with optional dependencies enabled.",
    );
  };
  await assert.rejects(
    () => listCookieSourceBrowsers(unavailable),
    /Reinstall BetterWright with optional dependencies enabled/,
  );
  await assert.rejects(
    () => listCookieSourceProfiles("chrome", {}, unavailable),
    /Reinstall BetterWright with optional dependencies enabled/,
  );
});

test("Cookie Sync replaces source failures without echoing source secrets", async () => {
  const sentinel = "COOKIE_SECRET_SENTINEL";
  const broken = reader({});
  broken.read = async () => {
    throw new Error(`native failure included ${sentinel}`);
  };
  await assert.rejects(
    () =>
      extractCookieSync(
        normalizeCookieSyncOptions({ source: { browser: "chrome" } }),
        async () => broken,
      ),
    (error: any) => !error.message.includes(sentinel) && /could not read/.test(error.message),
  );
});

test("Cookie Sync enforces count and encoded-size limits", () => {
  const tooMany = Array.from({ length: COOKIE_SYNC_MAX_COOKIES + 1 }, (_, index) =>
    detailed({ name: `c${index}`, value: "x" }),
  );
  assert.throws(
    () => normalizeCookieSnapshot(
      { detailedCookies: tooMany, warnings: [] },
      { source: { browser: "chrome" } },
    ),
    /more than 10000 cookies/,
  );

  const tooLarge = Array.from({ length: 950 }, (_, index) =>
    detailed({ name: `large${index}`, value: "x".repeat(7_000) }),
  );
  assert.throws(
    () => normalizeCookieSnapshot(
      { detailedCookies: tooLarge, warnings: [] },
      { source: { browser: "chrome" } },
    ),
    /secure transfer limit/,
  );
});

test("worker-side Cookie Sync validation accepts the wire shape and rejects secret-bearing corruption", () => {
  const cookie = normalizeCookieSnapshot(
    {
      detailedCookies: [detailed(
        { expires: Date.now() / 1000 + 60 },
        { topFrameSiteKey: "https://top.example", hasCrossSiteAncestor: true },
      )],
      warnings: [],
    },
    { source: { browser: "chrome" } },
  ).cookies[0];
  assert.deepEqual(validateCookieSyncTargetCookies([cookie]), [cookie]);
  assert.throws(
    () => validateCookieSyncTargetCookies([{ ...cookie, value: "bad\nvalue" }]),
    /malformed cookie batch/,
  );
  assert.deepEqual(
    validateCookieSyncTargetCookies([{ ...cookie, expires: Date.now() / 1000 - 1 }]),
    [],
  );
});

test("source browser and profile discovery returns only bounded public metadata", async () => {
  const fake = {
    version: () => "0.6.0",
    read: async () => ({ detailedCookies: [], warnings: [] }),
    supportedBrowsers: async () => [
      { id: "chrome", displayName: "Google Chrome", engine: "chromium", secret: "drop" },
      { id: "", displayName: "bad", engine: "x" },
    ],
    browserProfiles: async () => [
      {
        profile: {
          profileId: "profile-1",
          displayName: "Work",
          path: "/private/source/path",
        },
        isDefault: true,
        sources: [{ path: "/private/cookies" }],
      },
    ],
  };
  assert.deepEqual(await listCookieSourceBrowsers(async () => fake), [
    { id: "chrome", name: "Google Chrome", engine: "chromium" },
  ]);
  assert.deepEqual(
    await listCookieSourceProfiles("chrome", {}, async () => fake),
    [{ id: "profile-1", name: "Work", isDefault: true }],
  );
});

test("the pinned native reader loads and advertises the mainstream browser families", async () => {
  const browsers = await listCookieSourceBrowsers();
  const ids = new Set(browsers.map((browser) => browser.id));
  assert.equal(ids.has("chrome"), true);
  assert.equal(ids.has("firefox"), true);
  assert.equal(ids.has("safari"), process.platform === "darwin");
});
