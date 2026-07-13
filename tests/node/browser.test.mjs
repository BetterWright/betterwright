// End-to-end Node tests. Skipped unless a Chromium build is resolvable, so the
// policy suite still runs on machines without the runtime installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

import { BetterWright, NetworkPolicy } from "../../src/index.mjs";

const require = createRequire(import.meta.url);

function runtimeReady() {
  try {
    const core = process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH
      ? path.join(process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH, "index.js")
      : "playwright-core";
    const { chromium } = require(core);
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const ready = runtimeReady();
const opts = { skip: ready ? false : "browser runtime not installed" };

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-test-"));
}

test("navigate and read the title", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), policy: new NetworkPolicy(), headless: true });
  try {
    const result = await bw.run("await page.goto('https://example.com'); return page.title()");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "Example Domain");
  } finally {
    await bw.close();
  }
});

test("metadata endpoint is blocked", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run("await page.goto('http://169.254.169.254/'); return 'reached'");
    assert.equal(result.ok, false);
  } finally {
    await bw.close();
  }
});

test("screenshot without an extension still yields a png", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    await bw.run("await page.goto('https://example.com')");
    const result = await bw.run("return screenshot({kind: 'proof', name: 'home'})");
    assert.equal(result.ok, true, result.error);
    assert.ok(result.artifacts[0].path.endsWith(".png"));
  } finally {
    await bw.close();
  }
});
