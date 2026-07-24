import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  accountConfigPath,
  clearAccountConfig,
  isBetterWrightApiKey,
  loadAccountConfig,
  maskBetterWrightApiKey,
  normalizeRelayUrl,
  saveAccountApiKey,
  verifyBetterWrightApiKey,
} from "../../src/account-config.mjs";

const KEY = `bw_live_${"a".repeat(16)}_${"b".repeat(43)}`;

test("account API keys validate, mask, and persist in an owner-only separate file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-account-"));
  try {
    assert.equal(isBetterWrightApiKey(KEY), true);
    assert.equal(isBetterWrightApiKey("not-a-key"), false);
    const file = saveAccountApiKey(KEY, { home, relayUrl: "https://live.betterwright.com/" });
    assert.equal(file, accountConfigPath(home));
    assert.equal(loadAccountConfig(home).apiKey, KEY);
    assert.equal(loadAccountConfig(home).relayUrl, "https://live.betterwright.com");
    assert.ok(!maskBetterWrightApiKey(KEY).includes("b".repeat(20)));
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    clearAccountConfig(home);
    assert.equal(loadAccountConfig(home).apiKey, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("relay URLs fail closed to HTTPS except explicit loopback tests", () => {
  assert.equal(normalizeRelayUrl("https://live.betterwright.com/"), "https://live.betterwright.com");
  assert.equal(normalizeRelayUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeRelayUrl("http://example.com"), /https/i);
  assert.throws(() => normalizeRelayUrl("https://user:pass@example.com"), /credentials/i);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-account-invalid-"));
  try {
    fs.writeFileSync(accountConfigPath(home), JSON.stringify({ apiKey: KEY, relayUrl: "http://wrong.example" }));
    assert.throws(() => loadAccountConfig(home), /https/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("API-key verification sends a bearer token and returns quota without exposing it", async () => {
  let authorization = "";
  let requestedUrl = "";
  const result = await verifyBetterWrightApiKey(KEY, {
    relayUrl: "https://live.betterwright.com",
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      authorization = options.headers.authorization;
      return new Response(
        JSON.stringify({ ok: true, quota: { remainingSeconds: 7200, resetAt: "2026-07-27T00:00:00.000Z" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(requestedUrl, "https://live.betterwright.com/v1/cli/me");
  assert.equal(authorization, `Bearer ${KEY}`);
  assert.equal(result.ok, true);
  assert.equal(result.quota.remainingSeconds, 7200);
});


test("an explicit environment key wins and an invalid one never falls back to disk", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bw-account-env-"));
  const previous = process.env.BETTERWRIGHT_API_KEY;
  const environmentKey = `bw_live_${"c".repeat(16)}_${"d".repeat(43)}`;
  try {
    saveAccountApiKey(KEY, { home });

    delete process.env.BETTERWRIGHT_API_KEY;
    assert.equal(loadAccountConfig(home).apiKey, KEY);

    process.env.BETTERWRIGHT_API_KEY = environmentKey;
    assert.equal(loadAccountConfig(home).apiKey, environmentKey);
    assert.equal(loadAccountConfig(home).source, "environment");

    process.env.BETTERWRIGHT_API_KEY = "bw_live_typo";
    assert.throws(() => loadAccountConfig(home), /refusing to fall back/i);
  } finally {
    if (previous === undefined) delete process.env.BETTERWRIGHT_API_KEY;
    else process.env.BETTERWRIGHT_API_KEY = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
