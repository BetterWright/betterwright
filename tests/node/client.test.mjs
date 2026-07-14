import assert from "node:assert/strict";
import { test } from "node:test";

import { BetterWright } from "../../src/index.mjs";

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

test("public search result UIs are blocked by default and opt-in", async () => {
  const guarded = new BetterWright();
  const allowed = new BetterWright({ publicSearchPolicy: "allow" });
  try {
    assert.equal(guarded.publicSearchPolicy, "block");
    assert.equal(guarded._workerConfig().publicSearchPolicy, "block");
    assert.equal(allowed._workerConfig().publicSearchPolicy, "allow");
    assert.throws(
      () => new BetterWright({ publicSearchPolicy: "pace" }),
      /publicSearchPolicy must be "block" or "allow"/,
    );
  } finally {
    await guarded.close();
    await allowed.close();
  }
});

test("CloakBrowser is the managed default", async () => {
  const browser = new BetterWright();
  try {
    assert.equal(browser.browserFlavor, "cloak");
    assert.equal(browser._workerConfig().browserFlavor, "cloak");
  } finally {
    await browser.close();
  }
});

test("each browser flavor gets its own profile directory", async () => {
  const cloak = new BetterWright();
  const chromium = new BetterWright({ browser: "chromium" });
  const custom = new BetterWright({ executablePath: "/opt/chromium" });
  try {
    // Cloak keeps the historical path so existing saved logins survive.
    assert.match(cloak._workerConfig().profileDir, /[/\\]profile$/);
    // The stock-Chromium fallback (explicit or via executablePath) is isolated
    // so its newer Chromium can never upgrade cloak's profile out from under it.
    assert.match(chromium._workerConfig().profileDir, /[/\\]profile-chromium$/);
    assert.match(custom._workerConfig().profileDir, /[/\\]profile-chromium$/);
    assert.notEqual(
      cloak._workerConfig().profileDir,
      chromium._workerConfig().profileDir,
    );
  } finally {
    await cloak.close();
    await chromium.close();
    await custom.close();
  }
});

test("CLOAKBROWSER_BINARY_PATH overrides the managed Cloak binary", async () => {
  const previous = process.env.CLOAKBROWSER_BINARY_PATH;
  process.env.CLOAKBROWSER_BINARY_PATH = "/opt/cloak/chrome";
  const browser = new BetterWright();
  try {
    assert.equal(browser.executablePath, "/opt/cloak/chrome");
    assert.equal(browser.browserFlavor, "cloak");
    assert.equal(browser._workerConfig().browserFlavor, "cloak");
  } finally {
    await browser.close();
    if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
    else process.env.CLOAKBROWSER_BINARY_PATH = previous;
  }
});

test("an explicit executable wins over CLOAKBROWSER_BINARY_PATH", async () => {
  const previous = process.env.CLOAKBROWSER_BINARY_PATH;
  process.env.CLOAKBROWSER_BINARY_PATH = "/opt/cloak/chrome";
  const browser = new BetterWright({ executablePath: "/opt/chromium" });
  try {
    assert.equal(browser.executablePath, "/opt/chromium");
    assert.equal(browser.browserFlavor, "chromium");
  } finally {
    await browser.close();
    if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
    else process.env.CLOAKBROWSER_BINARY_PATH = previous;
  }
});

test("stock Chromium must be selected explicitly", async () => {
  const browser = new BetterWright({ browser: "chromium" });
  try {
    assert.equal(browser.executablePath, "");
    assert.equal(browser.browserFlavor, "chromium");
    assert.throws(() => new BetterWright({ browser: "other" }), /cloak.*chromium/i);
  } finally {
    await browser.close();
  }
});
