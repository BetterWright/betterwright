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
  removeProviderAccount,
  resolveConnectedProvider,
  saveCustomProvider,
  saveDefaultBrowser,
  saveProviderAccount,
} from "../../dist/src/browser-config.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function writeConfig(home, config) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(browserConfigPath(home), JSON.stringify(config));
}

test("missing or malformed config reads as no defaults", () => {
  const home = makeTempDir("bw-config-");
  assert.deepEqual(loadBrowserConfig(home), { custom: {}, accounts: {} });
  fs.writeFileSync(browserConfigPath(home), "{not json");
  assert.deepEqual(loadBrowserConfig(home), { custom: {}, accounts: {} });
  fs.writeFileSync(browserConfigPath(home), JSON.stringify([1, 2]));
  assert.deepEqual(loadBrowserConfig(home), { custom: {}, accounts: {} });
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
  assert.deepEqual(config.accounts, {});
});

test("load keeps well-formed accounts and drops unknown or empty ones", () => {
  const home = makeTempDir("bw-config-accounts-");
  writeConfig(home, {
    browser: {
      accounts: {
        kernel: { apiKey: "kern_saved", surprise: true },
        nope: { apiKey: "x" },
        steel: {},
        browserbase: { keyEnv: "BROWSERBASE_API_KEY" },
      },
    },
  });
  assert.deepEqual(loadBrowserConfig(home).accounts, {
    kernel: { apiKey: "kern_saved" },
    browserbase: { keyEnv: "BROWSERBASE_API_KEY" },
  });
});

test("saveProviderAccount stores a key without changing the launch default", () => {
  const home = makeTempDir("bw-config-save-account-");
  saveProviderAccount("kernel", { apiKey: "kern_live_secret" }, home);
  const loaded = loadBrowserConfig(home);
  assert.equal(loaded.default, undefined);
  assert.deepEqual(loaded.accounts, { kernel: { apiKey: "kern_live_secret" } });
  const onDisk = JSON.parse(fs.readFileSync(browserConfigPath(home), "utf8"));
  assert.equal(onDisk.browser.accounts.kernel.apiKey, "kern_live_secret");
  const connected = resolveConnectedProvider("kernel", { home, env: {} });
  assert.equal(connected.apiKey, "kern_live_secret");
  assert.equal(connected.source, "account");
  assert.equal(removeProviderAccount("kernel", home), true);
  assert.deepEqual(loadBrowserConfig(home).accounts, {});
  assert.equal(removeProviderAccount("kernel", home), false);
});

test("saveProviderAccount rejects unknown names and empty credentials", () => {
  const home = makeTempDir("bw-config-account-validate-");
  assert.throws(() => saveProviderAccount("nope", { apiKey: "x" }, home), /Unknown provider/);
  assert.throws(() => saveProviderAccount("kernel", {}, home), /--browser-key/);
});

test("resolveConnectedProvider prefers --browser-key over a saved account and env", () => {
  const home = makeTempDir("bw-config-resolve-");
  saveProviderAccount("browserbase", { apiKey: "saved-bb" }, home);
  const env = { BROWSERBASE_API_KEY: "env-bb" };
  const fromFlag = resolveConnectedProvider("browserbase", {
    home,
    env,
    apiKey: "flag-bb",
  });
  assert.equal(fromFlag.apiKey, "flag-bb");
  assert.equal(fromFlag.source, "flag");
  const fromSaved = resolveConnectedProvider("browserbase", { home, env: {} });
  assert.equal(fromSaved.apiKey, "saved-bb");
  assert.equal(fromSaved.source, "account");
});

test("resolveConnectedProvider reads the well-known env var when nothing is saved", () => {
  const home = makeTempDir("bw-config-env-");
  const connected = resolveConnectedProvider("hyperbrowser", {
    home,
    env: { HYPERBROWSER_API_KEY: "env-hb" },
  });
  assert.equal(connected.apiKey, "env-hb");
  assert.equal(connected.source, "env");
  assert.equal(connected.keyEnv, "HYPERBROWSER_API_KEY");
  assert.throws(
    () => resolveConnectedProvider("hyperbrowser", { home, env: {} }),
    /No API key for Hyperbrowser/,
  );
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
