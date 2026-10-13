import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { daemonConfigFromFlags } from "../../dist/bin/cli-main.js";
import { BetterWright } from "../../dist/src/client.js";
import { daemonConfigSignature, normalizeDaemonConfig } from "../../dist/src/daemon.js";
import { launchOptionsFromEnv, loadLaunchConfig } from "../../dist/src/launch-config.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("launch defaults validate each allowed key and ignore unknown options", () => {
  const home = makeTempDir("betterwright-launch-");
  const file = path.join(home, "config.json");
  assert.deepEqual(loadLaunchConfig(home), {});
  fs.writeFileSync(file, "broken json");
  assert.deepEqual(loadLaunchConfig(home), {});
  fs.writeFileSync(file, JSON.stringify({ launch: {
    headless: "auto", headedInvisible: true, profile: "research", adBlock: false,
    locale: "en-us", timezone: "America/New_York", downloadPolicy: "deny",
    provider: { cdpUrl: "http://example.test" }, policy: {}, vault: false,
  } }));
  assert.deepEqual(loadLaunchConfig(home), {
    headless: "auto", headedInvisible: true, profile: "research", adBlock: false,
    locale: "en-US", timezone: "America/New_York", downloadPolicy: "deny",
  });
  fs.writeFileSync(file, JSON.stringify({ launch: {
    headless: "false", headedInvisible: 1, profile: "../escape", adBlock: "yes",
    locale: "not_a_locale", timezone: "Mars/Olympus", downloadPolicy: "sometimes",
  } }));
  assert.deepEqual(loadLaunchConfig(home), {});
});

test("environment and explicit constructor options override saved launch defaults", async () => {
  const home = makeTempDir("betterwright-launch-precedence-");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ launch: {
    headless: false, headedInvisible: true, profile: "saved", adBlock: false,
    locale: "de-DE", timezone: "Europe/Berlin", downloadPolicy: "deny",
  } }));
  const env = { BETTERWRIGHT_HEADLESS: "1", BETTERWRIGHT_PROFILE: "environment",
    BETTERWRIGHT_AD_BLOCK: "1", BETTERWRIGHT_LOCALE: "en-GB",
    BETTERWRIGHT_TIMEZONE: "Europe/London", BETTERWRIGHT_DOWNLOAD_POLICY: "ask" };
  assert.deepEqual(launchOptionsFromEnv(home, env), {
    headless: true, headedInvisible: false, profile: "environment", adBlock: true,
    locale: "en-GB", timezone: "Europe/London", downloadPolicy: "ask",
  });
  const inherited = new BetterWright({ home, vault: false });
  const explicit = new BetterWright({ home, vault: undefined, headless: true, profile: null,
    adBlock: true, locale: "fr-FR", timezone: "UTC", downloadPolicy: "allow" });
  try {
    assert.equal(inherited.headedInvisible, true);
    assert.equal(inherited.headless, false);
    assert.equal(inherited.profile, "saved");
    assert.equal(inherited.downloadPolicy, "deny");
    assert.equal(explicit.headedInvisible, false);
    assert.equal(explicit.headless, true);
    assert.equal(explicit.profile, null);
    assert.equal(explicit.adBlock, true);
    assert.equal(explicit.locale, "fr-FR");
    assert.equal(explicit.timezone, "UTC");
    assert.equal(explicit.downloadPolicy, "allow");
    assert.equal(explicit.vault, null);
  } finally {
    await inherited.close();
    await explicit.close();
  }
});

test("CLI daemon config includes saved identity, display and download policy in its signature", () => {
  const home = makeTempDir("betterwright-launch-daemon-");
  const file = path.join(home, "config.json");
  fs.writeFileSync(file, JSON.stringify({ launch: {
    profile: "research", headless: "auto", downloadPolicy: "deny", adBlock: false,
  } }));
  const config = daemonConfigFromFlags(new Set(), { home, argv: [], env: {} });
  assert.equal(config.profile, "research");
  assert.equal(config.headless, "auto");
  assert.equal(config.browser.adBlock, false);
  assert.equal(normalizeDaemonConfig(config).browser.downloadPolicy, "deny");
  const signature = daemonConfigSignature(config);
  fs.writeFileSync(file, JSON.stringify({ launch: { profile: "research", downloadPolicy: "allow" } }));
  assert.notEqual(daemonConfigSignature(daemonConfigFromFlags(new Set(), { home, argv: [], env: {} })), signature);
  const headed = daemonConfigFromFlags(new Set(["--headed", "--ad-block"]), { home, argv: [], env: {} });
  assert.equal(headed.headless, false);
  assert.equal(headed.browser.headedInvisible, false);
  assert.equal(headed.browser.adBlock, true);
});

test("explicit SDK settings bypass invalid lower-priority environment values", async () => {
  const home = makeTempDir("betterwright-launch-invalid-env-");
  const settings = {
    BETTERWRIGHT_HEADLESS: "invalid",
    BETTERWRIGHT_PROFILE: "../invalid",
    BETTERWRIGHT_AD_BLOCK: "invalid",
    BETTERWRIGHT_DOWNLOAD_POLICY: "invalid",
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const explicit = { home, vault: false as const, headless: true, profile: null, adBlock: false, downloadPolicy: "deny" as const };
  try {
    const browser = new BetterWright(explicit);
    const invisible = new BetterWright({ ...explicit, headless: undefined, headedInvisible: true, profile: "valid" });
    try {
      assert.equal(browser.headless, true);
      assert.equal(browser.profile, null);
      assert.equal(browser.adBlock, false);
      assert.equal(browser.downloadPolicy, "deny");
      assert.equal(invisible.headless, false);
      assert.equal(invisible.headedInvisible, true);
      assert.equal(invisible.profile, "valid");
      // Invalid values still fail when the caller actually inherits them.
      assert.throws(() => new BetterWright({ ...explicit, headless: undefined }), /BETTERWRIGHT_HEADLESS/);
      assert.throws(() => new BetterWright({ ...explicit, profile: undefined }), /invalid profile/);
      assert.throws(() => new BetterWright({ ...explicit, adBlock: undefined }), /BETTERWRIGHT_AD_BLOCK/);
      assert.throws(() => new BetterWright({ ...explicit, downloadPolicy: undefined }), /BETTERWRIGHT_DOWNLOAD_POLICY/);
    } finally {
      await browser.close();
      await invisible.close();
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("explicit CLI flags bypass invalid overridden environment settings", () => {
  const home = makeTempDir("betterwright-launch-cli-precedence-");
  const flags = new Set(["--headed", "--no-ad-block", "--profile"]);
  const config = daemonConfigFromFlags(flags, {
    home, argv: ["--headed", "--no-ad-block", "--profile", "valid"],
    env: { BETTERWRIGHT_HEADLESS: "invalid", BETTERWRIGHT_AD_BLOCK: "invalid", BETTERWRIGHT_PROFILE: "../invalid" },
  });
  assert.equal(config.headless, false);
  assert.equal(config.browser.adBlock, false);
  assert.equal(config.profile, "valid");
});
