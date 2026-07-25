import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import {
  assertProfileNotNewer,
  managedCloakArgs,
  managedCloakViewport,
} from "../../src/cloak.mjs";
import { BetterWright, NetworkPolicy } from "../../src/index.mjs";
import { makeTempDir } from "./helpers/temp-dir.mjs";

const enabled = process.env.BETTERWRIGHT_CLOAK_E2E === "1";
const opts = { skip: enabled ? false : "set BETTERWRIGHT_CLOAK_E2E=1" };

test("managed Cloak arguments omit resolver rules and suppress bad-flag bars", () => {
  const args = managedCloakArgs("12345");
  assert.deepEqual(args, [
    "--test-type",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--fingerprint=12345",
  ]);
  assert.equal(
    args.some((arg) => arg.startsWith("--host-resolver-rules")),
    false,
  );
});

test("managed Cloak viewports stay coherent on affected builds", () => {
  assert.deepEqual(
    managedCloakViewport(
      { tier: "free", platform: "darwin-arm64", version: "145.0.0" },
      true,
    ),
    { width: 1438, height: 679 },
  );
  assert.deepEqual(
    managedCloakViewport(
      { tier: "free", platform: "linux-x64", version: "146.0.0" },
      false,
    ),
    { width: 1365, height: 900 },
  );
  assert.equal(
    managedCloakViewport(
      { tier: "free", platform: "linux-x64", version: "146.0.0" },
      true,
    ),
    undefined,
  );
  assert.equal(
    managedCloakViewport(
      { tier: "pro", platform: "linux-x64", version: "146.0.0" },
      false,
    ),
    undefined,
  );
  assert.equal(
    managedCloakViewport(
      { tier: "free", platform: "linux-x64", version: "147.0.0" },
      false,
    ),
    undefined,
  );
});

test("assertProfileNotNewer rejects a profile upgraded by a newer Chromium", () => {
  const dir = makeTempDir("betterwright-profver-");
  try {
    // Fresh profile (no marker): no-op regardless of running version.
    assert.doesNotThrow(() => assertProfileNotNewer(dir, "145.0.7632.109"));

    fs.writeFileSync(path.join(dir, "Last Version"), "149.0.7827.55\n");
    // Older binary opening a newer profile is the crash we prevent.
    assert.throws(
      () => assertProfileNotNewer(dir, "145.0.7632.109"),
      /upgraded by a newer Chromium \(149\.0\.7827\.55\)/,
    );
    // Switching backends is the common cause, so the message has to name the
    // cause and the exact recovery — this is the one error a first-time user
    // most often hits, and "reset the profile" is useless without the path.
    assert.throws(
      () => assertProfileNotNewer(dir, "145.0.7632.109"),
      (error) =>
        error.message.includes(`rm -rf ${dir}`) &&
        /Chromium fork and CloakBrowser/.test(error.message) &&
        /BETTERWRIGHT_HOME/.test(error.message),
    );
    // Same or newer binary is fine.
    assert.doesNotThrow(() => assertProfileNotNewer(dir, "149.0.7827.55"));
    assert.doesNotThrow(() => assertProfileNotNewer(dir, "150.0.0.0"));
    // Unknown running version is a no-op (cannot compare safely).
    assert.doesNotThrow(() => assertProfileNotNewer(dir, ""));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("managed Cloak headed mode opens a coherent visible window", opts, async () => {
  const home = makeTempDir("betterwright-cloak-headed-");
  const browser = new BetterWright({ home, headless: false });
  try {
    assert.equal(browser.browserFlavor, "cloak");
    assert.equal(browser._workerConfig().browserFlavor, "cloak");
    assert.equal(browser._workerConfig().headless, false);
    const result = await browser.run(`
      return page.evaluate(() => ({
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        viewport: { width: innerWidth, height: innerHeight },
        outer: { width: outerWidth, height: outerHeight },
        screen: { width: screen.width, height: screen.height },
      }));
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.profileMode, "persistent");
    assert.equal(result.result.webdriver, false);
    assert.doesNotMatch(result.result.userAgent, /HeadlessChrome|Chrome for Testing/i);
    assert.ok(result.result.viewport.width > 0);
    assert.ok(result.result.viewport.height > 0);
    assert.ok(result.result.outer.width >= result.result.viewport.width);
    assert.ok(result.result.outer.height >= result.result.viewport.height);
    assert.ok(result.result.screen.width >= result.result.viewport.width);
    assert.ok(result.result.screen.height >= result.result.viewport.height);
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("managed Cloak browser hides test-browser signals and keeps one profile identity", opts, async () => {
  const home = makeTempDir("betterwright-cloak-");
  const server = http.createServer((request, response) => {
    const delay = request.url === "/slow-fetch" ? 650 : 700;
    setTimeout(() => {
      if (request.url === "/slow-fetch") {
        response.writeHead(200, {
          "access-control-allow-origin": "*",
          "content-type": "application/json",
        });
        response.end('{"ready":true}');
        return;
      }
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(
        request.url === "/slow-frame.js"
          ? "window.frameContentReady = true;"
          : "window.pageContentReady = true;",
      );
    }, delay);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const seedFile = path.join(
    home,
    "browser",
    "profile",
    ".betterwright-fingerprint-seed",
  );
  try {
    const first = new BetterWright({
      home,
      browser: "cloak",
      headless: true,
      policy: new NetworkPolicy({ allowLoopback: true }),
    });
    let firstResult;
    let contentResult;
    let frameContentResult;
    let networkIdleResult;
    try {
      firstResult = await first.run(`
        return page.evaluate(() => ({
          webdriver: navigator.webdriver,
          userAgent: navigator.userAgent,
          screen: {
            width: screen.width,
            height: screen.height,
            availWidth: screen.availWidth,
            availHeight: screen.availHeight,
          },
          viewport: {width: innerWidth, height: innerHeight},
          outer: {width: outerWidth, height: outerHeight},
        }));
      `);
      contentResult = await first.run(`
        const startedAt = Date.now();
        await page.setContent(
          ${JSON.stringify(`<h1>Managed content</h1><script src="${origin}/slow-page.js"></script>`)}
        );
        return {
          text: await page.locator('h1').innerText(),
          contentReady: await page.evaluate(() => window.pageContentReady),
          readyState: await page.evaluate(() => document.readyState),
          elapsed: Date.now() - startedAt,
        };
      `);
      frameContentResult = await first.run(`
        await page.setContent('<iframe title="managed-frame"></iframe>');
        const frame = page.frames().find(candidate => candidate !== page.mainFrame());
        const startedAt = Date.now();
        await frame.setContent(
          ${JSON.stringify(`<h2>Frame content</h2><script src="${origin}/slow-frame.js"></script>`)}
        );
        return {
          text: await frame.locator('h2').innerText(),
          contentReady: await frame.evaluate(() => window.frameContentReady),
          readyState: await frame.evaluate(() => document.readyState),
          elapsed: Date.now() - startedAt,
        };
      `);
      networkIdleResult = await first.run(`
        const startedAt = Date.now();
        await page.setContent(
          ${JSON.stringify(`<script>fetch("${origin}/slow-fetch").then(() => { window.fetchReady = true; });</script>`)},
          { waitUntil: 'networkidle' }
        );
        return {
          fetchReady: await page.evaluate(() => window.fetchReady),
          readyState: await page.evaluate(() => document.readyState),
          elapsed: Date.now() - startedAt,
        };
      `);
    } finally {
      await first.close();
    }
    assert.equal(firstResult.ok, true, firstResult.error);
    assert.equal(firstResult.result.webdriver, false);
    assert.doesNotMatch(firstResult.result.userAgent, /HeadlessChrome|Chrome for Testing/i);
    assert.ok(firstResult.result.screen.availWidth >= firstResult.result.viewport.width);
    assert.ok(firstResult.result.screen.availHeight >= firstResult.result.viewport.height);
    assert.ok(firstResult.result.outer.width >= firstResult.result.viewport.width);
    assert.ok(firstResult.result.outer.height >= firstResult.result.viewport.height);
    assert.ok(firstResult.result.screen.width >= firstResult.result.outer.width);
    assert.ok(firstResult.result.screen.height >= firstResult.result.outer.height);

    assert.equal(contentResult.ok, true, contentResult.error);
    assert.equal(contentResult.result.text, "Managed content");
    assert.equal(contentResult.result.contentReady, true);
    assert.equal(contentResult.result.readyState, "complete");
    assert.ok(contentResult.result.elapsed >= 600, contentResult.result.elapsed);

    assert.equal(frameContentResult.ok, true, frameContentResult.error);
    assert.equal(frameContentResult.result.text, "Frame content");
    assert.equal(frameContentResult.result.contentReady, true);
    assert.equal(frameContentResult.result.readyState, "complete");
    assert.ok(
      frameContentResult.result.elapsed >= 600,
      frameContentResult.result.elapsed,
    );

    assert.equal(networkIdleResult.ok, true, networkIdleResult.error);
    assert.equal(networkIdleResult.result.fetchReady, true);
    assert.equal(networkIdleResult.result.readyState, "complete");
    assert.ok(
      networkIdleResult.result.elapsed >= 1_050,
      networkIdleResult.result.elapsed,
    );

    const seed = fs.readFileSync(seedFile, "utf8").trim();
    assert.match(seed, /^[1-9][0-9]{4}$/);

    const second = new BetterWright({ home, browser: "cloak", headless: true });
    try {
      const secondResult = await second.run(
        "return page.evaluate(() => navigator.userAgent)",
      );
      assert.equal(secondResult.ok, true, secondResult.error);
      assert.doesNotMatch(secondResult.result, /HeadlessChrome|Chrome for Testing/i);
    } finally {
      await second.close();
    }
    assert.equal(fs.readFileSync(seedFile, "utf8").trim(), seed);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
