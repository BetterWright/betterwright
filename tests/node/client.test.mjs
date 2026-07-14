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

test("CLOAKBROWSER_BINARY_PATH opts into an installed Cloak binary", async () => {
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
