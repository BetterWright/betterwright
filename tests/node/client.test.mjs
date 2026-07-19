import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BetterWright, LocalCredentialVault } from "../../src/index.mjs";

test("the encrypted local credential vault is enabled by default and can be replaced or disabled", async () => {
  const home = path.join(os.tmpdir(), "betterwright-client-default-vault");
  const local = new BetterWright({ home });
  const customVault = { async handleRequest() {} };
  const custom = new BetterWright({ vault: customVault });
  const disabled = new BetterWright({ vault: false });
  const disabledWithNull = new BetterWright({ vault: null });
  try {
    assert.ok(local.vault instanceof LocalCredentialVault);
    assert.equal(local.vault.dir, path.join(home, "vault"));
    assert.equal(custom.vault, customVault);
    assert.equal(disabled.vault, null);
    assert.equal(disabledWithNull.vault, null);
    assert.throws(
      () => new BetterWright({ vault: true }),
      /vault must implement handleRequest/,
    );
  } finally {
    await local.close();
    await custom.close();
    await disabled.close();
    await disabledWithNull.close();
  }
});

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

test("headed and headless modes use the same managed Cloak profile", async () => {
  const headed = new BetterWright({ headless: false });
  const headless = new BetterWright({ headless: true });
  try {
    assert.equal(headed.browserFlavor, "cloak");
    assert.equal(headless.browserFlavor, "cloak");
    assert.equal(headed.headless, false);
    assert.equal(headless.headless, true);
    assert.match(headed._workerConfig().profileDir, /[/\\]profile$/);
    assert.equal(
      headed._workerConfig().profileDir,
      headless._workerConfig().profileDir,
    );
  } finally {
    await headed.close();
    await headless.close();
  }
});

test("stock browsers, custom executables, and CDP attach are rejected", () => {
  assert.throws(
    () => new BetterWright({ browser: "chromium" }),
    /only supports the managed CloakBrowser backend/,
  );
  assert.throws(
    () => new BetterWright({ browser: "other" }),
    /only supports the managed CloakBrowser backend/,
  );
  assert.throws(
    () => new BetterWright({ executablePath: "/opt/chromium" }),
    /CLOAKBROWSER_BINARY_PATH/,
  );
  assert.throws(
    () => new BetterWright({ connectOverCdp: "http://127.0.0.1:9222" }),
    /connectOverCdp is not supported/,
  );
  assert.doesNotThrow(() => new BetterWright({ connectOverCdp: "" }));
});

test("legacy environment settings cannot re-enable a stock browser", () => {
  const previousBrowser = process.env.BETTERWRIGHT_BROWSER;
  const previousCdp = process.env.BETTERWRIGHT_CONNECT_OVER_CDP;
  try {
    process.env.BETTERWRIGHT_BROWSER = "chromium";
    assert.throws(
      () => new BetterWright(),
      /only supports the managed CloakBrowser backend/,
    );
    process.env.BETTERWRIGHT_BROWSER = "cloak";
    process.env.BETTERWRIGHT_CONNECT_OVER_CDP = "http://127.0.0.1:9222";
    assert.throws(
      () => new BetterWright(),
      /connectOverCdp is not supported/,
    );
  } finally {
    if (previousBrowser === undefined) delete process.env.BETTERWRIGHT_BROWSER;
    else process.env.BETTERWRIGHT_BROWSER = previousBrowser;
    if (previousCdp === undefined) delete process.env.BETTERWRIGHT_CONNECT_OVER_CDP;
    else process.env.BETTERWRIGHT_CONNECT_OVER_CDP = previousCdp;
  }
});

test("CLOAKBROWSER_BINARY_PATH remains the only binary override", async () => {
  const previous = process.env.CLOAKBROWSER_BINARY_PATH;
  process.env.CLOAKBROWSER_BINARY_PATH = "/opt/cloak/chrome";
  const browser = new BetterWright();
  try {
    assert.equal(browser.browserFlavor, "cloak");
    assert.equal(browser._workerConfig().browserFlavor, "cloak");
    assert.equal("executablePath" in browser._workerConfig(), false);
  } finally {
    await browser.close();
    if (previous === undefined) delete process.env.CLOAKBROWSER_BINARY_PATH;
    else process.env.CLOAKBROWSER_BINARY_PATH = previous;
  }
});
