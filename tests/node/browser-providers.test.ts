import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  browserProviderInfo,
  describeCdpUrl,
  redactProviderSecrets,
  resolveBrowserProvider,
} from "../../dist/src/browser-providers.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("no provider means the managed BetterChromium fork", () => {
  assert.equal(resolveBrowserProvider(null, { env: {} }), null);
  assert.equal(resolveBrowserProvider(undefined, { env: {} }), null);
});

test("BETTERWRIGHT_CDP_URL is the host-level CDP shorthand", () => {
  const resolved = resolveBrowserProvider(null, {
    env: { BETTERWRIGHT_CDP_URL: "wss://browser.example.com" },
  });
  assert.equal(resolved.plan.kind, "remote");
  assert.equal(resolved.plan.cdpUrl, "wss://browser.example.com/");
  assert.match(resolved.plan.warnings[0], /guard proxy/);
});

test("exactly one provider kind per launch", () => {
  assert.throws(
    () => resolveBrowserProvider({ cdpUrl: "wss://x", provider: "kernel" }),
    /exactly one of/,
  );
  assert.throws(() => resolveBrowserProvider({}), /exactly one of/);
  assert.throws(() => resolveBrowserProvider("not-an-object-but-passed-as-string"), TypeError);
  assert.throws(() => resolveBrowserProvider(42), TypeError);
});

test("executablePath launches a local binary inside the guard proxy", () => {
  const dir = makeTempDir("bw-provider-exe-");
  const binary = `${dir}/chrome`;
  fs.writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
  const resolved = resolveBrowserProvider({ executablePath: binary });
  assert.equal(resolved.plan.kind, "local");
  assert.equal(resolved.plan.executablePath, binary);
  assert.match(resolved.plan.warnings[0], /guard proxy/);
  // Nonexistent absolute path fails at resolution.
  assert.throws(
    () => resolveBrowserProvider({ executablePath: "/no/such/chrome" }),
    /does not exist/,
  );
  assert.throws(
    () => resolveBrowserProvider({ executablePath: "relative/chrome" }),
    /absolute path/,
  );
});

test("cdpUrl must be a ws(s) endpoint; diagnostics mask credentials", () => {
  assert.throws(
    () => resolveBrowserProvider({ cdpUrl: "https://example.com" }),
    /ws:\/\/ or wss:\/\//,
  );
  assert.throws(() => resolveBrowserProvider({ cdpUrl: "not a url" }), /ws(s)?/);
  const resolved = resolveBrowserProvider({
    cdpUrl: "wss://user:pass@browser.example.com?apiKey=SECRET&keepAlive=1",
  });
  assert.equal(
    resolved.plan.endpointLabel,
    "wss://***:***@browser.example.com/?apiKey=***&keepAlive=1",
  );
  assert.equal(
    describeCdpUrl("wss://host?token=abc"),
    "wss://host/?token=***",
  );
});

test("custom headers ride the CDP connect call", () => {
  const resolved = resolveBrowserProvider({
    cdpUrl: "wss://browser.example.com",
    headers: { "x-api-key": "k" },
  });
  assert.deepEqual(resolved.plan.headers, { "x-api-key": "k" });
  assert.throws(
    () =>
      resolveBrowserProvider({
        cdpUrl: "wss://browser.example.com",
        headers: { "x-api-key": 42 },
      }),
    /must be a string/,
  );
});

test("named providers need a key, from the option or their env var", () => {
  assert.throws(
    () => resolveBrowserProvider({ provider: "browserbase" }, { env: {} }),
    /BROWSERBASE_API_KEY/,
  );
  const resolved = resolveBrowserProvider(
    { provider: "browserbase" },
    { env: { BROWSERBASE_API_KEY: "bb_live_x" } },
  );
  assert.equal(resolved.plan.kind, "remote");
  assert.equal(resolved.plan.provider, "browserbase");
  assert.equal(typeof resolved.plan.create, "function");
  assert.equal(resolved.plan.apiKey, "bb_live_x");
  assert.throws(
    () => resolveBrowserProvider({ provider: "nope" }),
    /Unknown browser provider/,
  );
  assert.deepEqual(browserProviderInfo("kernel"), {
    name: "Kernel",
    docs: "https://www.kernel.sh/docs",
    keyEnv: "KERNEL_API_KEY",
  });
  assert.equal(browserProviderInfo("nope"), null);
});

test("REST providers mint the session lazily at launch time", async () => {
  const resolved = resolveBrowserProvider(
    { provider: "browserbase", apiKey: "bb_live_x" },
    { env: {} },
  );
  const calls = [];
  const plan = await resolved.plan.create({
    fetchJson: async (url, init) => {
      calls.push({ url, init });
      return { id: "sess_1", connectUrl: "wss://connect.browserbase.com/devtools/abc" };
    },
  });
  assert.deepEqual(calls, [
    {
      url: "https://api.browserbase.com/v1/sessions",
      init: {
        method: "POST",
        headers: { "x-bb-api-key": "bb_live_x" },
        body: {},
      },
    },
  ]);
  assert.equal(plan.cdpUrl, "wss://connect.browserbase.com/devtools/abc");
  assert.equal(plan.sessionId, "sess_1");
  // Releasing the session releases it on the provider, too.
  await plan.end();
  assert.equal(
    calls[1].url,
    "https://api.browserbase.com/v1/sessions/sess_1",
  );
  assert.deepEqual(calls[1].init.body, { status: "REQUEST_RELEASE" });
  assert.match(plan.warnings[0], /Browserbase/);
});

test("kernel and hyperbrowser mint CDP endpoints from their APIs", async () => {
  const kernel = resolveBrowserProvider(
    { provider: "kernel", apiKey: "k", sessionOptions: { stealth: true } },
    { env: {} },
  );
  const kernelCalls = [];
  const kernelPlan = await kernel.plan.create({
    fetchJson: async (url, init) => {
      kernelCalls.push({ url, init });
      return { session_id: "s9", cdp_ws_url: "wss://onkernel.com/devtools/s9" };
    },
  });
  assert.deepEqual(kernelCalls[0], {
    url: "https://api.onkernel.com/browsers",
    init: {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: { stealth: true },
    },
  });
  assert.equal(kernelPlan.cdpUrl, "wss://onkernel.com/devtools/s9");
  await kernelPlan.end();
  assert.equal(kernelCalls[1].url, "https://api.onkernel.com/browsers/s9");
  assert.equal(kernelCalls[1].init.method, "DELETE");

  const hyperCalls = [];
  const hyper = resolveBrowserProvider(
    { provider: "hyperbrowser", apiKey: "h" },
    { env: {} },
  );
  const hyperPlan = await hyper.plan.create({
    fetchJson: async (url, init) => {
      hyperCalls.push({ url, init });
      return { id: "42", wsEndpoint: "wss://hyper/x" };
    },
  });
  assert.equal(hyperCalls[0].url, "https://api.hyperbrowser.ai/api/session");
  assert.deepEqual(hyperCalls[0].init.headers, { "x-api-key": "h" });
  assert.equal(hyperPlan.cdpUrl, "wss://hyper/x");
  await hyperPlan.end();
  assert.equal(
    hyperCalls[1].url,
    "https://api.hyperbrowser.ai/api/session/42/stop",
  );
});

test("anchor reports the nested session fields", async () => {
  const resolved = resolveBrowserProvider(
    { provider: "anchor", apiKey: "a" },
    { env: {} },
  );
  const plan = await resolved.plan.create({
    fetchJson: async (url, init) => {
      assert.equal(url, "https://api.anchorbrowser.io/api/v1/sessions");
      assert.deepEqual(init.headers, { "anchor-api-key": "a" });
      return { data: { id: "anch_1", cdp_url: "wss://anchor/x" } };
    },
  });
  assert.equal(plan.cdpUrl, "wss://anchor/x");
  assert.equal(plan.sessionId, "anch_1");
  assert.equal(plan.end, null); // Anchor sessions end on disconnect.
});

test("a provider whose response lacks a CDP URL fails clearly", async () => {
  const resolved = resolveBrowserProvider(
    { provider: "browserbase", apiKey: "k" },
    { env: {} },
  );
  await assert.rejects(
    () => resolved.plan.create({ fetchJson: async () => ({ id: "x" }) }),
    /did not include a CDP WebSocket URL/,
  );
});

test("browser-use, steel, and browserless mint the endpoint with no REST call", () => {
  const bu = resolveBrowserProvider(
    { provider: "browser-use", apiKey: "bu_key", sessionOptions: { proxyCountryCode: "DE" } },
    { env: {} },
  );
  assert.equal(
    bu.plan.cdpUrl,
    "wss://connect.browser-use.com/?apiKey=bu_key&proxyCountryCode=DE",
  );
  assert.equal(bu.plan.create, undefined);

  const steel = resolveBrowserProvider(
    { provider: "steel", apiKey: "st", sessionOptions: { sessionId: "s1" } },
    { env: {} },
  );
  assert.equal(
    steel.plan.cdpUrl,
    "wss://connect.steel.dev/?apiKey=st&sessionId=s1",
  );

  const bl = resolveBrowserProvider(
    { provider: "browserless", apiKey: "tok", sessionOptions: { blockAds: true } },
    { env: {} },
  );
  assert.equal(
    bl.plan.cdpUrl,
    "wss://production-sfo.browserless.io/chromium?token=tok&blockAds=true",
  );
});

test("brightdata and oxylabs take userinfo credentials", () => {
  const brd = resolveBrowserProvider(
    { provider: "brightdata", apiKey: "brd-customer-hl_1-zone-scraping_browser1:pw9" },
    { env: {} },
  );
  const brdUrl = new URL(brd.plan.cdpUrl);
  assert.equal(brdUrl.username, "brd-customer-hl_1-zone-scraping_browser1");
  assert.equal(brdUrl.password, "pw9");
  assert.equal(brdUrl.host, "brd.superproxy.io:9222");
  assert.match(brd.plan.endpointLabel, /\*\*\*:\*\*\*@/);
  assert.throws(
    () => resolveBrowserProvider({ provider: "brightdata", apiKey: "nopassword" }, { env: {} }),
    /zone credential/,
  );

  const oxy = resolveBrowserProvider(
    { provider: "oxylabs", apiKey: "user-p1:pass", sessionOptions: { p_cc: "US" } },
    { env: {} },
  );
  const oxyUrl = new URL(oxy.plan.cdpUrl);
  assert.equal(oxyUrl.username, "user-p1");
  assert.equal(oxyUrl.password, "pass");
  assert.equal(oxyUrl.searchParams.get("p_cc"), "US");
});

test("provider secrets are registered for result-envelope redaction", () => {
  const tracked = [];
  const trackSecret = (value) => tracked.push(value);
  const resolved = resolveBrowserProvider(
    { provider: "browser-use", apiKey: "bu_secret_key" },
    { env: {} },
  );
  redactProviderSecrets(trackSecret, resolved.plan);
  assert.ok(tracked.includes("bu_secret_key"));
  assert.ok(tracked.includes(encodeURIComponent("bu_secret_key")));

  const tracked2 = [];
  redactProviderSecrets((v) => tracked2.push(v), {
    cdpUrl: "wss://user:pass@host?apiKey=K",
    headers: { authorization: "Bearer hdr" },
  });
  assert.ok(tracked2.includes("pass"));
  assert.ok(tracked2.includes("K"));
  assert.ok(tracked2.includes("hdr"));
});
