import assert from "node:assert/strict";
import { test } from "node:test";

import { findChromeExecutable } from "../../src/chrome.mjs";
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

test("connectOverCdp default is display-aware and explicit values win", async () => {
  const prevDisplay = process.env.BETTERWRIGHT_DISPLAY;
  const prevEnv = process.env.BETTERWRIGHT_CONNECT_OVER_CDP;
  delete process.env.BETTERWRIGHT_CONNECT_OVER_CDP;
  const made = [];
  const mk = (opts) => {
    const bw = new BetterWright(opts);
    made.push(bw);
    return bw;
  };
  try {
    // Headless: always the launched sandbox (network floor intact).
    process.env.BETTERWRIGHT_DISPLAY = "0";
    assert.equal(mk().connectOverCdp, "");

    // Headed (desktop): real Chrome over CDP when Chrome is installed.
    process.env.BETTERWRIGHT_DISPLAY = "1";
    const chromePresent = Boolean(findChromeExecutable());
    assert.equal(mk().connectOverCdp, chromePresent ? "auto" : "");

    // The default tracks the resolved headless decision, not raw display:
    // an explicit headless:true always uses the sandbox even on a desktop.
    assert.equal(mk({ headless: true }).connectOverCdp, "");
    // ...and headless:false uses CDP (when Chrome exists) even without a display.
    process.env.BETTERWRIGHT_DISPLAY = "0";
    assert.equal(
      mk({ headless: false }).connectOverCdp,
      chromePresent ? "auto" : "",
    );
    process.env.BETTERWRIGHT_DISPLAY = "1";

    // Explicit "" forces the sandbox even on a desktop with Chrome.
    assert.equal(mk({ connectOverCdp: "" }).connectOverCdp, "");

    // An explicit endpoint is used verbatim.
    assert.equal(
      mk({ connectOverCdp: "http://127.0.0.1:9222" }).connectOverCdp,
      "http://127.0.0.1:9222",
    );

    // The env override applies only when no option is passed.
    process.env.BETTERWRIGHT_CONNECT_OVER_CDP = "http://127.0.0.1:9333";
    assert.equal(mk().connectOverCdp, "http://127.0.0.1:9333");
  } finally {
    for (const bw of made) await bw.close();
    if (prevDisplay === undefined) delete process.env.BETTERWRIGHT_DISPLAY;
    else process.env.BETTERWRIGHT_DISPLAY = prevDisplay;
    if (prevEnv === undefined) delete process.env.BETTERWRIGHT_CONNECT_OVER_CDP;
    else process.env.BETTERWRIGHT_CONNECT_OVER_CDP = prevEnv;
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
