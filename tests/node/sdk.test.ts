import assert from "node:assert/strict";
import test from "node:test";

import * as providers from "../../dist/src/browser-providers.js";
import * as client from "../../dist/src/client.js";
import * as index from "../../dist/src/index.js";
import * as sdk from "../../dist/src/sdk.js";
import { isCallable } from "../../dist/src/untrusted-value.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// Exports the SDK entrypoint shares with the root export. They must be the
// same binding, not a copy: `instanceof` checks and the vault's identity
// comparisons break the moment a consumer mixes the two entrypoints.
const SHARED_WITH_ROOT = [
  "BetterWright",
  "BrowserError",
  "NetworkPolicy",
  "METADATA_ADDRESSES",
  "METADATA_HOSTNAMES",
  "createLocalCredentialVault",
  "LocalCredentialVault",
  "LocalCredentialVaultError",
  "VAULT_CATEGORIES",
  "VAULT_MATCH_MODES",
  "agentSystemPrompt",
  "runAgentTask",
  "resolveModel",
  "resolveModelSelection",
];

// withBrowser closes the client it constructed, and the callback is the only
// place a test can reach that client. Wrapping close() there records the call
// and still runs the real teardown.
function trackClose(bw, calls) {
  const close = bw.close.bind(bw);
  bw.close = async () => {
    calls.push(bw);
    await close();
  };
}

test("the SDK entrypoint re-exports the root export's bindings, not copies", () => {
  // Copied out because indexing a namespace import by variable is linted
  // away; the copies still hold the same references.
  const sdkExports = { ...sdk };
  const rootExports = { ...index };
  for (const name of SHARED_WITH_ROOT) {
    assert.ok(sdkExports[name], `sdk is missing ${name}`);
    assert.equal(sdkExports[name], rootExports[name], `sdk.${name} is not the root binding`);
  }
  assert.equal(sdk.validateCredentialMatchMode, client.validateCredentialMatchMode);
  assert.equal(sdk.browserProviderInfo, providers.browserProviderInfo);
  assert.equal(sdk.BROWSER_PROVIDER_NAMES, providers.BROWSER_PROVIDER_NAMES);
  assert.equal(sdk.REST_BROWSER_PROVIDER_NAMES, providers.REST_BROWSER_PROVIDER_NAMES);
  assert.equal(sdk.describeCdpUrl, providers.describeCdpUrl);
  assert.equal(sdk.createProviderSession, providers.createProviderSession);
  assert.equal(sdk.listProviderSessions, providers.listProviderSessions);
  assert.equal(sdk.getProviderSession, providers.getProviderSession);
  assert.equal(sdk.stopProviderSession, providers.stopProviderSession);
});

test("withBrowser is the only export the root export does not have", () => {
  assert.ok(isCallable(sdk.withBrowser));
  assert.equal(index.withBrowser, undefined);
  const added = Object.keys(sdk).filter((name) => !(name in index));
  assert.deepEqual(added.sort(), [
    "BROWSER_PROVIDER_NAMES",
    "REST_BROWSER_PROVIDER_NAMES",
    "browserProviderInfo",
    "createProviderSession",
    "describeCdpUrl",
    "getProviderSession",
    "listProviderSessions",
    "stopProviderSession",
    "validateCredentialMatchMode",
    "withBrowser",
  ]);
});

test("withBrowser returns the callback's value and closes the client", async () => {
  const home = makeTempDir("bw-sdk-with-browser-");
  const closed = [];
  const seen = [];
  const title = await sdk.withBrowser({ home }, async (bw) => {
    trackClose(bw, closed);
    seen.push(bw);
    return "Example Domain";
  });
  assert.equal(title, "Example Domain");
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof sdk.BetterWright);
  assert.equal(seen[0].home, home);
  assert.deepEqual(closed, seen);
});

test("withBrowser closes the client when the callback throws", async () => {
  const home = makeTempDir("bw-sdk-with-browser-throws-");
  const closed = [];
  await assert.rejects(
    () =>
      sdk.withBrowser({ home }, async (bw) => {
        trackClose(bw, closed);
        throw new Error("callback failed");
      }),
    /callback failed/,
  );
  assert.equal(closed.length, 1);
});

test("withBrowser accepts a callback alone, with the default options", async () => {
  const closed = [];
  const home = makeTempDir("bw-sdk-with-browser-default-");
  process.env.BETTERWRIGHT_HOME = home;
  try {
    const result = await sdk.withBrowser(async (bw) => {
      trackClose(bw, closed);
      assert.ok(bw instanceof sdk.BetterWright);
      assert.equal(bw.home, home);
      return 42;
    });
    assert.equal(result, 42);
  } finally {
    delete process.env.BETTERWRIGHT_HOME;
  }
  assert.equal(closed.length, 1);
});
