/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${apiKey}` is the literal placeholder custom cdpUrl templates carry */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  browserConfigPath,
  configuredDefaultProvider,
  expandProviderChoice,
  loadBrowserConfig,
  removeCustomProvider,
  saveCustomProvider,
  saveDefaultBrowser,
} from "../../dist/src/browser-config.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function writeConfig(home, config) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(browserConfigPath(home), JSON.stringify(config));
}

test("missing or malformed config reads as no defaults", () => {
  const home = makeTempDir("bw-config-");
  assert.deepEqual(loadBrowserConfig(home), { custom: {} });
  fs.writeFileSync(browserConfigPath(home), "{not json");
  assert.deepEqual(loadBrowserConfig(home), { custom: {} });
  fs.writeFileSync(browserConfigPath(home), JSON.stringify([1, 2]));
  assert.deepEqual(loadBrowserConfig(home), { custom: {} });
});

test("load drops malformed defaults, bad names, and unknown keys", () => {
  const home = makeTempDir("bw-config-");
  writeConfig(home, {
    browser: {
      default: { provider: "steel", cdpUrl: "wss://two-kinds" },
      custom: {
        "Bad Name": { cdpUrl: "wss://x" },
        ok: { cdpUrl: "wss://ok.example", surprise: true, keyEnv: "OK_KEY" },
        "no-url": { keyEnv: "X" },
      },
    },
  });
  const config = loadBrowserConfig(home);
  assert.equal(config.default, undefined);
  assert.deepEqual(Object.keys(config.custom), ["ok"]);
  assert.deepEqual(config.custom.ok, { cdpUrl: "wss://ok.example", keyEnv: "OK_KEY" });
});

test("saveDefaultBrowser round-trips and preserves unrelated sections", () => {
  const home = makeTempDir("bw-config-");
  writeConfig(home, { liveView: { expose: "lan" } });
  const file = saveDefaultBrowser({ provider: "steel", keyEnv: "MY_STEEL" }, home);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(raw.liveView, { expose: "lan" });
  assert.deepEqual(loadBrowserConfig(home).default, {
    provider: "steel",
    keyEnv: "MY_STEEL",
  });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  saveDefaultBrowser(null, home);
  assert.equal(loadBrowserConfig(home).default, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).liveView, { expose: "lan" });
});

test("saveDefaultBrowser validates the ref", () => {
  const home = makeTempDir("bw-config-");
  assert.throws(() => saveDefaultBrowser({}, home), /exactly one of/);
  assert.throws(
    () => saveDefaultBrowser({ provider: "steel", cdpUrl: "wss://x" }, home),
    /exactly one of/,
  );
  assert.throws(() => saveDefaultBrowser({ provider: "nope" }, home), /Unknown provider/);
});

test("custom providers save, become valid defaults, and remove", () => {
  const home = makeTempDir("bw-config-");
  const { name } = saveCustomProvider(
    "  DriverDotNet  ",
    { cdpUrl: "wss://connect.example.com?apiKey=${apiKey}", keyEnv: "DRIVER_KEY" },
    home,
  );
  assert.equal(name, "driverdotnet");
  assert.equal(
    loadBrowserConfig(home).custom.driverdotnet.cdpUrl,
    "wss://connect.example.com?apiKey=${apiKey}",
  );
  saveDefaultBrowser({ provider: "driverdotnet" }, home);
  assert.deepEqual(loadBrowserConfig(home).default, { provider: "driverdotnet" });
  assert.equal(removeCustomProvider("driverdotnet", home), true);
  assert.equal(removeCustomProvider("driverdotnet", home), false);
  assert.deepEqual(loadBrowserConfig(home).custom, {});
});

test("saveCustomProvider rejects bad names and bad templates", () => {
  const home = makeTempDir("bw-config-");
  assert.throws(() => saveCustomProvider("Bad Name", { cdpUrl: "wss://x" }, home), /1-32/);
  assert.throws(() => saveCustomProvider("steel", { cdpUrl: "wss://x" }, home), /built-in/);
  assert.throws(() => saveCustomProvider("cdp", { cdpUrl: "wss://x" }, home), /built-in/);
  assert.throws(() => saveCustomProvider("mine", {}, home), /needs a cdpUrl/);
  assert.throws(
    () => saveCustomProvider("mine", { cdpUrl: "https://example.com" }, home),
    /ws:\/\/ or wss:\/\//,
  );
  assert.throws(() => saveCustomProvider("mine", { cdpUrl: "not a url" }, home), /valid URL/);
});

test("expandProviderChoice passes built-ins and endpoints through", () => {
  const home = makeTempDir("bw-config-");
  assert.equal(expandProviderChoice(null, { home }), null);
  assert.equal(expandProviderChoice(false, { home }), false);
  const builtIn = { provider: "kernel", apiKey: "k" };
  assert.equal(expandProviderChoice(builtIn, { home, env: {} }), builtIn);
  const endpoint = { cdpUrl: "wss://x.example" };
  assert.equal(expandProviderChoice(endpoint, { home, env: {} }), endpoint);
  const local = { executablePath: "/opt/chrome" };
  assert.equal(expandProviderChoice(local, { home, env: {} }), local);
  assert.deepEqual(expandProviderChoice("steel", { home, env: {} }), { provider: "steel" });
});

test("expandProviderChoice resolves keyEnv for a stored built-in ref", () => {
  const home = makeTempDir("bw-config-");
  const env = { MY_STEEL: "sk-123" };
  assert.deepEqual(
    expandProviderChoice({ provider: "steel", keyEnv: "MY_STEEL" }, { home, env }),
    { provider: "steel", apiKey: "sk-123" },
  );
  assert.throws(
    () => expandProviderChoice({ provider: "steel", keyEnv: "MY_STEEL" }, { home, env: {} }),
    /MY_STEEL, which is not set/,
  );
});

test("expandProviderChoice expands custom names with key substitution", () => {
  const home = makeTempDir("bw-config-");
  saveCustomProvider(
    "mine",
    {
      cdpUrl: "wss://connect.example.com?apiKey=${apiKey}",
      headers: { "x-api-key": "${apiKey}" },
      keyEnv: "MINE_KEY",
    },
    home,
  );
  const expanded = expandProviderChoice("mine", { home, env: { MINE_KEY: "sk-9" } });
  assert.deepEqual(expanded, {
    cdpUrl: "wss://connect.example.com?apiKey=sk-9",
    headers: { "x-api-key": "sk-9" },
  });
  const explicit = expandProviderChoice(
    { provider: "mine", apiKey: "override" },
    { home, env: { MINE_KEY: "sk-9" } },
  );
  assert.equal(explicit.cdpUrl, "wss://connect.example.com?apiKey=override");
  assert.throws(() => expandProviderChoice("mine", { home, env: {} }), /needs an API key/);
});

test("expandProviderChoice names configured providers in its unknown error", () => {
  const home = makeTempDir("bw-config-");
  saveCustomProvider("mine", { cdpUrl: "wss://x.example" }, home);
  assert.throws(
    () => expandProviderChoice("missing", { home, env: {} }),
    /Configured: mine/,
  );
});

test("a custom provider with no placeholder needs no key", () => {
  const home = makeTempDir("bw-config-");
  saveCustomProvider("open", { cdpUrl: "ws://127.0.0.1:9222/devtools" }, home);
  assert.deepEqual(expandProviderChoice("open", { home, env: {} }), {
    cdpUrl: "ws://127.0.0.1:9222/devtools",
  });
});

test("configuredDefaultProvider expands the persisted default", () => {
  const home = makeTempDir("bw-config-");
  assert.equal(configuredDefaultProvider({ home, env: {} }), null);
  saveCustomProvider(
    "mine",
    { cdpUrl: "wss://connect.example.com?apiKey=${apiKey}", keyEnv: "MINE_KEY" },
    home,
  );
  saveDefaultBrowser({ provider: "mine" }, home);
  assert.deepEqual(configuredDefaultProvider({ home, env: { MINE_KEY: "sk" } }), {
    cdpUrl: "wss://connect.example.com?apiKey=sk",
  });
  saveDefaultBrowser({ cdpUrl: "wss://direct.example" }, home);
  assert.deepEqual(configuredDefaultProvider({ home, env: {} }), {
    cdpUrl: "wss://direct.example",
  });
});
