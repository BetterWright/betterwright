// End-to-end Node tests. Skipped unless a Chromium build is resolvable, so the
// policy suite still runs on machines without the runtime installed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { BetterWright, NetworkPolicy } from "../../src/index.mjs";

const require = createRequire(import.meta.url);

// The broad deterministic suite exercises BetterWright's worker contract with
// Playwright's pinned test browser. A separate opt-in E2E test covers the real
// managed Cloak binary.
process.env.BETTERWRIGHT_BROWSER = "chromium";

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

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function externalChromium() {
  const core = process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH
    ? path.join(process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH, "index.js")
    : "playwright-core";
  const { chromium } = require(core);
  const port = await unusedPort();
  const profileDir = tempHome();
  const child = spawn(
    chromium.executablePath(),
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    {
      stdio: "ignore",
      detached: process.platform !== "win32",
    },
  );
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return { child, endpoint, profileDir };
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  signalExternalChromium(child, "SIGTERM");
  throw new Error(`External Chromium did not start at ${endpoint}.`);
}

function signalExternalChromium(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already have exited; fall back to the parent.
    }
  }
  if (child.exitCode === null) child.kill(signal);
}

async function closeExternalChromium(runtime) {
  signalExternalChromium(runtime.child, "SIGTERM");
  if (runtime.child.exitCode === null)
    await Promise.race([
      once(runtime.child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  // Chrome may fork profile-writing children before the tracked parent exits.
  signalExternalChromium(runtime.child, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 250));
  fs.rmSync(runtime.profileDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

function unsupportedDownloadGuardModule() {
  const actualDir =
    process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH ||
    path.dirname(require.resolve("playwright-core"));
  const actualUrl = pathToFileURL(path.join(actualDir, "index.mjs")).href;
  const wrapperDir = tempHome();
  fs.writeFileSync(
    path.join(wrapperDir, "index.mjs"),
    `import * as actual from ${JSON.stringify(actualUrl)};
export * from ${JSON.stringify(actualUrl)};
export const chromium = new Proxy(actual.chromium, {
  get(target, property) {
    if (property !== "connectOverCDP") return Reflect.get(target, property);
    return async (...args) => {
      const browser = await target.connectOverCDP(...args);
      const original = browser.newBrowserCDPSession.bind(browser);
      browser.newBrowserCDPSession = async () => {
        const session = await original();
        const send = session.send.bind(session);
        session.send = async (method, params) => {
          if (method === "Browser.setDownloadBehavior") {
            throw new Error(
              "Protocol error (Browser.setDownloadBehavior): " +
              "Browser context management is not supported.",
            );
          }
          return send(method, params);
        };
        return session;
      };
      return browser;
    };
  },
});
`,
  );
  return wrapperDir;
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "betterwright-test-"));
}

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

class LimitedBetterWright extends BetterWright {
  constructor(options, limits) {
    super(options);
    this.limits = limits;
  }

  _workerConfig() {
    return { ...super._workerConfig(), ...this.limits };
  }
}

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else total += fs.statSync(target).size;
  }
  return total;
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

test("public search UIs route agents to the host search tool", opts, async () => {
  // Public search is allowed by default now, so opt into the block routing.
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    publicSearchPolicy: "block",
  });
  try {
    const direct = await bw.run(
      "await page.goto('https://www.google.com/search?q=betterwright'); return 'loaded'",
    );
    assert.equal(direct.ok, false);
    assert.match(direct.error, /host web-search\/research tool/i);

    const clicked = await bw.run(`
      await page.setContent(
        '<a id="search" href="https://www.bing.com/search?q=betterwright">Search</a>'
      );
      await page.locator('#search').click();
      return page.url();
    `);
    assert.equal(clicked.ok, false);
    assert.ok(
      clicked.events?.some((event) => event.type === "public-search-blocked"),
      JSON.stringify(clicked.events),
    );

    for (const url of [
      "https://www.bing.com/images/search?q=betterwright",
      "https://www.bing.com/videos/search?q=betterwright",
      "https://www.bing.com/news/search?q=betterwright",
      "https://lite.duckduckgo.com/lite/?q=betterwright",
    ]) {
      const variant = await bw.run(
        `await page.goto(${JSON.stringify(url)}); return 'loaded'`,
      );
      assert.equal(variant.ok, false, url);
      assert.match(variant.error, /host web-search\/research tool/i, url);
    }
  } finally {
    await bw.close();
  }
});

test("attach mode can drive an externally launched Chromium", opts, async () => {
  const runtime = await externalChromium();
  const wrapperDir = unsupportedDownloadGuardModule();
  const previousCorePath = process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH;
  process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH = wrapperDir;
  let downloadRequests = 0;
  const server = await listen((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/popup") {
      response.end("<title>Guarded Popup</title><h1>Popup</h1>");
      return;
    }
    if (request.url === "/report.txt") {
      downloadRequests += 1;
      response.setHeader("content-type", "text/plain");
      response.setHeader(
        "content-disposition",
        'attachment; filename="report.txt"',
      );
      response.end("must not be saved");
      return;
    }
    response.end(
      '<title>Attach Host</title>' +
        '<a id="popup" href="/popup" target="_blank">Open</a>' +
        '<a id="download" href="/report.txt" download>Download</a>',
    );
  });
  const bw = new BetterWright({
    home: path.join(runtime.profileDir, "betterwright"),
    connectOverCdp: runtime.endpoint,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      const host = page;
      const popupPromise = host.waitForEvent('popup');
      await host.locator('#popup').click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      await host.evaluate(() => {
        setTimeout(() => document.querySelector('#download').click(), 0);
      });
      await host.waitForTimeout(100);
      return {hostTitle: await host.title(), popupTitle: await popup.title()};
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, {
      hostTitle: "Attach Host",
      popupTitle: "Guarded Popup",
    });
    assert.equal(result.profileMode, "attached");
    assert.match(result.warnings.join(" "), /downloads are disabled while attached/);
    assert.equal(
      (result.artifacts || []).filter((item) => item.kind === "download").length,
      0,
    );
    assert.equal(downloadRequests, 1);
  } finally {
    await bw.close();
    await server.close();
    await closeExternalChromium(runtime);
    fs.rmSync(wrapperDir, { recursive: true, force: true });
    if (previousCorePath === undefined)
      delete process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH;
    else process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH = previousCorePath;
  }
});

test("attach failures do not expose the trusted CDP endpoint to model output", opts, async () => {
  const port = await unusedPort();
  const secret = "TOPSECRET-CDP-TOKEN";
  const endpoint = `http://127.0.0.1:${port}/json?token=${secret}`;
  const bw = new BetterWright({
    home: tempHome(),
    browser: "chromium",
    connectOverCdp: endpoint,
  });
  try {
    const result = await bw.run("return page.url()", { timeout: 5 });
    assert.equal(result.ok, false);
    assert.match(result.error, /REDACTED_CDP_ENDPOINT/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(String(port)));
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

test("IPv4-mapped IPv6 cannot reach an IPv4 loopback service", opts, async () => {
  let hits = 0;
  const server = await listen((_request, response) => {
    hits += 1;
    response.end("loopback reached");
  });
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(
      `await page.goto('http://[::ffff:127.0.0.1]:${server.port}/'); return 'reached'`,
    );
    assert.equal(result.ok, false);
    assert.equal(hits, 0);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("setInputFiles only reads files from the artifact root", opts, async () => {
  const home = tempHome();
  const outside = path.join(home, "host-secret.txt");
  const outsideScript = path.join(home, "host-secret.js");
  const allowed = path.join(home, "artifacts", "upload.txt");
  const linkedOutside = path.join(home, "artifacts", "linked-secret.txt");
  fs.mkdirSync(path.dirname(allowed), { recursive: true });
  fs.writeFileSync(outside, "host-secret-value");
  fs.writeFileSync(outsideScript, "globalThis.hostSecret = 'read';");
  fs.writeFileSync(allowed, "allowed-artifact-value");
  if (process.platform !== "win32") fs.symlinkSync(outside, linkedOutside);
  const bw = new BetterWright({ home, headless: true });
  try {
    const denied = await bw.run(`
      await page.setContent('<input type="file">');
      await page.locator('input').setInputFiles(${JSON.stringify(outside)});
      return page.locator('input').evaluate(element => element.files[0].text());
    `);
    assert.equal(denied.ok, false);
    assert.match(denied.error || "", /artifact directory/i);

    const accepted = await bw.run(`
      await page.setContent('<input type="file">');
      await page.locator('input').setInputFiles(${JSON.stringify(allowed)});
      return page.locator('input').evaluate(element => element.files[0].text());
    `);
    assert.equal(accepted.ok, true, accepted.error);
    assert.equal(accepted.result, "allowed-artifact-value");

    const chooserDenied = await bw.run(`
      await page.setContent('<input type="file">');
      const chooserPromise = page.waitForEvent('filechooser');
      await page.locator('input').click();
      const chooser = await chooserPromise;
      await chooser.setFiles(${JSON.stringify(outside)});
      return 'read';
    `);
    assert.equal(chooserDenied.ok, false);
    assert.match(chooserDenied.error || "", /artifact directory/i);

    const initScriptDenied = await bw.run(`
      await page.addInitScript({path: ${JSON.stringify(outsideScript)}});
      return 'read';
    `);
    assert.equal(initScriptDenied.ok, false);
    assert.match(initScriptDenied.error || "", /artifact directory/i);

    if (process.platform !== "win32") {
      const symlinkDenied = await bw.run(`
        await page.setContent('<input type="file">');
        await page.locator('input').setInputFiles(${JSON.stringify(linkedOutside)});
        return 'read';
      `);
      assert.equal(symlinkDenied.ok, false);
      assert.match(symlinkDenied.error || "", /artifact directory/i);
    }
  } finally {
    await bw.close();
  }
});

test("vault fills are unavailable to model-authored snippets", opts, async () => {
  const secret = "vault-secret-value";
  const server = await listen((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end('<input type="password">');
  });
  const vault = {
    async handleRequest(action, _payload, origin) {
      assert.equal(action, "fill");
      return { secret, origin, username: "alice" };
    },
  };
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
    vault,
  });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await credentials.fill({username: 'alice'});
      return page.locator('input[type=password]').evaluate(element => btoa(element.value));
    `);
    assert.equal(result.ok, false);
    assert.match(result.error || "", /disabled.*untrusted|untrusted.*disabled/i);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("guard decisions are not reused across request methods", opts, async () => {
  let deleteRequests = 0;
  const server = await listen((request, response) => {
    if (request.method === "DELETE") deleteRequests += 1;
    response.setHeader("content-type", request.url === "/" ? "text/html" : "text/plain");
    response.end(request.url === "/" ? "<h1>cache test</h1>" : "ok");
  });
  const policy = new NetworkPolicy({
    allowLoopback: true,
    custom: (_url, details) =>
      details.method === "DELETE" ? { allowed: false, reason: "DELETE denied" } : null,
  });
  const bw = new BetterWright({ home: tempHome(), headless: true, policy });
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      return page.evaluate(async () => {
        await fetch('/api');
        try {
          await fetch('/api', {method: 'DELETE'});
          return 'allowed';
        } catch {
          return 'blocked';
        }
      });
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "blocked");
    assert.equal(deleteRequests, 0);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("screenshots are rejected before an oversized file is written", opts, async () => {
  const home = tempHome();
  const bw = new LimitedBetterWright(
    { home, headless: true },
    { maxScreenshotBytes: 512 },
  );
  try {
    const result = await bw.run(`
      await page.setContent('<main style="width:1000px;height:1000px;background:red"></main>');
      return screenshot({kind: 'proof', name: 'oversized.png'});
    `);
    assert.equal(result.ok, false);
    assert.match(result.error || "", /screenshot.*limit/i);
    assert.equal(directorySize(path.join(home, "artifacts")), 0);
  } finally {
    await bw.close();
  }
});

test("downloads are canceled while crossing the byte limit", opts, async () => {
  const chunk = Buffer.alloc(4096, 0x61);
  const chunkCount = 64;
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end(`
        <a id="download-1" href="/large-1.bin" download>Download one</a>
        <a id="download-2" href="/large-2.bin" download>Download two</a>
      `);
      return;
    }
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("content-disposition", 'attachment; filename="large.bin"');
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= chunkCount || response.destroyed) {
        clearInterval(timer);
        if (!response.destroyed) response.end();
        return;
      }
      response.write(chunk);
      sent += 1;
    }, 50);
    response.on("close", () => clearInterval(timer));
  });
  const home = tempHome();
  const maxDownloadBytes = 32 * 1024;
  const bw = new LimitedBetterWright(
    {
      home,
      headless: true,
      downloadPolicy: "allow",
      policy: new NetworkPolicy({ allowLoopback: true }),
    },
    { maxArtifactBytes: maxDownloadBytes, maxDownloadBytes },
  );
  let maxObserved = 0;
  const observer = setInterval(() => {
    maxObserved = Math.max(maxObserved, directorySize(path.join(home, "artifacts")));
  }, 10);
  try {
    const result = await bw.run(`
      await page.goto(${JSON.stringify(server.origin)});
      await page.locator('#download-1').click();
      await page.waitForTimeout(100);
      await page.locator('#download-2').click();
      await page.waitForTimeout(1500);
      return 'done';
    `);
    assert.equal(result.ok, true, result.error);
    assert.ok(
      maxObserved <= maxDownloadBytes + chunk.length * 4,
      `download grew to ${maxObserved} bytes before cancellation`,
    );
    const rejected = (result.events || []).filter(
      event => event.type === "download-rejected",
    );
    assert.equal(rejected.length, 2, JSON.stringify(result.events));
  } finally {
    clearInterval(observer);
    await bw.close();
    await server.close();
  }
});

test("downloads require a trusted per-run approval by default", opts, async () => {
  const body = Buffer.from("approved download contents");
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    response.setHeader("content-type", "text/plain");
    response.setHeader(
      "content-disposition",
      'attachment; filename="report.txt"',
    );
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  const code = `
    await page.goto(${JSON.stringify(server.origin)});
    await page.locator('#download').click();
    await page.waitForTimeout(100);
    return 'done';
  `;
  try {
    const blocked = await bw.run(code);
    assert.equal(blocked.ok, true, blocked.error);
    assert.equal(
      directorySize(path.join(home, "artifacts", "downloads")),
      0,
    );
    assert.equal(
      (blocked.artifacts || []).filter((item) => item.kind === "download").length,
      0,
    );

    const approved = await bw.run(code, { approvedDownloads: true });
    assert.equal(approved.ok, true, approved.error);
    const downloads = (approved.artifacts || []).filter(
      (item) => item.kind === "download",
    );
    assert.equal(downloads.length, 1, JSON.stringify(approved.events));
    assert.deepEqual(fs.readFileSync(downloads[0].path), body);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("download approval cannot be borrowed by a different browser session", opts, async () => {
  const body = Buffer.from("cross-session download must stay blocked");
  let downloadRequests = 0;
  const server = await listen((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<a id="download" href="/report.txt" download>Download</a>');
      return;
    }
    downloadRequests += 1;
    response.setHeader("content-type", "text/plain");
    response.setHeader(
      "content-disposition",
      'attachment; filename="report.txt"',
    );
    response.end(body);
  });
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
    policy: new NetworkPolicy({ allowLoopback: true }),
  });
  try {
    const armed = await bw.run(
      `
        await page.goto(${JSON.stringify(server.origin)});
        await page.evaluate(() => {
          setTimeout(() => {
            window.downloadAttempted = true;
            document.querySelector('#download').click();
          }, 750);
        });
        return 'armed';
      `,
      { session: "attacker" },
    );
    assert.equal(armed.ok, true, armed.error);

    const approvedVictim = await bw.run(
      "await page.waitForTimeout(1800); return 'victim complete'",
      { session: "victim", approvedDownloads: true },
    );
    assert.equal(approvedVictim.ok, true, approvedVictim.error);
    assert.equal(
      (approvedVictim.artifacts || []).some((item) => item.kind === "download"),
      false,
    );

    const attempted = await bw.run(
      "return page.evaluate(() => window.downloadAttempted === true)",
      { session: "attacker" },
    );
    assert.equal(attempted.result, true, attempted.error);
    assert.equal(downloadRequests, 1);
    assert.equal(directorySize(path.join(home, "artifacts")), 0);
  } finally {
    await bw.close();
    await server.close();
  }
});

test("downloadPolicy deny rejects even trusted approval", opts, async () => {
  const bw = new BetterWright({
    home: tempHome(),
    headless: true,
    downloadPolicy: "deny",
  });
  try {
    const result = await bw.run("state.executed = true; return 'ran'", {
      approvedDownloads: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.error || "", /downloadPolicy=deny/);
    const state = await bw.run("return state.executed ?? false");
    assert.equal(state.result, false);
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

test("visible bot challenges include actionable state and a vision artifact", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(
      "await page.setContent('<h1>One last step</h1><p>Please solve the challenge below to continue</p>'); return 'loaded'",
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.challenges?.[0]?.type, "bot_challenge");
    assert.equal(result.challenges?.[0]?.solve?.maxAttempts, 3);
    assert.ok(result.warnings?.some((warning) => /solve it before retrying/i.test(warning)));
    assert.ok(result.artifacts?.some((artifact) => artifact.kind === "captcha"));
  } finally {
    await bw.close();
  }
});

test("iframe-only bot challenges are detected", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<iframe srcdoc="<h1>Verify you are human</h1>"></iframe>');
      return 'loaded';
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.challenges?.[0]?.detectedIn, "frame");
  } finally {
    await bw.close();
  }
});

test("a completed provider response clears the challenge and resumes", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const unresolved = await bw.run(`
      await page.setContent(
        "<p>I'm not a robot</p>" +
        "<textarea hidden name='g-recaptcha-response'></textarea>" +
        "<textarea hidden name='g-recaptcha-response'></textarea>"
      );
      return 'waiting';
    `);
    assert.equal(unresolved.ok, true, unresolved.error);
    assert.equal(unresolved.challenges?.[0]?.provider, "recaptcha");

    const partial = await bw.run(`
      await page.locator('[name="g-recaptcha-response"]').first().evaluate(
        element => { element.value = 'first-provider-response'; }
      );
      return 'one widget remains';
    `);
    assert.equal(partial.challenges?.[0]?.provider, "recaptcha");

    const solved = await bw.run(`
      await page.locator('[name="g-recaptcha-response"]').evaluateAll(
        elements => elements.forEach(
          (element, index) => { element.value = 'provider-response-' + index; }
        )
      );
      return 'continue original task';
    `);
    assert.equal(solved.ok, true, solved.error);
    assert.equal(solved.result, "continue original task");
    assert.equal(solved.challenges, undefined);
  } finally {
    await bw.close();
  }
});

test("failed snippets preserve bot-challenge evidence for recovery", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<h1>Verify you are human to continue</h1>');
      throw new Error('blocked action');
    `);
    assert.equal(result.ok, false);
    assert.match(result.error, /blocked action/);
    assert.equal(result.challenges?.[0]?.type, "bot_challenge");
    assert.ok(result.artifacts?.some((artifact) => artifact.kind === "captcha"));
    assert.ok(Array.isArray(result.pages));
  } finally {
    await bw.close();
  }
});

test("timed-out challenge runs report that the page must be reopened", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(
      `
        await page.setContent('<h1>Verify you are human to continue</h1>');
        await new Promise(() => {});
      `,
      { timeout: 5 },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/i);
    assert.equal(result.challenges?.[0]?.solve?.resumeOnClear, false);
    assert.equal(result.challenges?.[0]?.solve?.reopenRequired, true);
    assert.equal(result.challenges?.[0]?.recovery?.pagePreserved, false);
    assert.match(result.warnings?.join(" ") || "", /next browser call, reopen/i);

    const restarted = await bw.run("return page.url()");
    assert.equal(restarted.ok, true, restarted.error);
  } finally {
    await bw.close();
  }
});

test("captcha.click activates a checkbox-style challenge and returns a fresh snapshot", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<button id="verify" style="width:300px;height:80px;padding:0">Verify you are human</button><script>window.pointerMoves=0;document.addEventListener("pointermove",()=>window.pointerMoves++);</script>');
      await page.locator('#verify').evaluate(element => {
        element.addEventListener('click', event => {
          const rect = element.getBoundingClientRect();
          window.clickRatio = (event.clientX - rect.left) / rect.width;
          if (window.clickRatio <= 0.2) element.textContent = 'Verified';
        });
      });
      const bounds = await page.locator('#verify').boundingBox();
      await captcha.click(bounds);
      return {
        text: await page.locator('#verify').textContent(),
        pointerMoves: await page.evaluate(() => window.pointerMoves),
        clickRatio: await page.evaluate(() => window.clickRatio),
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.text, "Verified");
    assert.ok(result.result.pointerMoves >= 18, result.result.pointerMoves);
    assert.ok(result.result.clickRatio >= 0.12, result.result.clickRatio);
    assert.ok(result.result.clickRatio <= 0.18, result.result.clickRatio);
  } finally {
    await bw.close();
  }
});

test("captcha.inspect emits a challenge image for model vision", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<div id="challenge" style="width:300px;height:180px">Select every bus</div>');
      const bounds = await page.locator('#challenge').boundingBox();
      return captcha.inspect(bounds);
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.kind, "captcha");
    assert.match(result.result.instruction, /inspect the attached challenge/i);
    assert.equal(result.artifacts?.[0]?.kind, "captcha");
  } finally {
    await bw.close();
  }
});

test("captcha.drag performs a smooth pointer drag and returns a fresh snapshot", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <button id="handle" style="position:absolute;left:40px;top:40px;width:40px;height:40px">Slide</button>
        <p id="status" aria-live="polite">Waiting</p>
        <script>
          let started = false;
          document.querySelector('#handle').addEventListener('mousedown', () => { started = true; });
          document.addEventListener('mouseup', event => {
            if (started && event.clientX > 200) document.querySelector('#status').textContent = 'Dragged';
          });
        </script>
      \`);
      const bounds = await page.locator('#handle').boundingBox();
      const from = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
      return captcha.drag(from, {x: 260, y: from.y}, {steps: 12});
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /Dragged/);
  } finally {
    await bw.close();
  }
});

test("captcha.readText emits only a cropped image artifact for Pi vision", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<div id="code" style="font:32px monospace;width:220px;height:70px">A7K9</div>');
      const bounds = await page.locator('#code').boundingBox();
      return captcha.readText(bounds);
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.kind, "captcha");
    assert.match(result.result.instruction, /attached CAPTCHA crop/i);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].kind, "captcha");
    assert.deepEqual(fs.readFileSync(result.artifacts[0].path).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } finally {
    await bw.close();
  }
});

test("human helpers use shaped pointer, keyboard, and wheel events", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent(\`
        <button id="go" style="margin:80px;width:180px;height:50px">Go</button>
        <input id="name" style="display:block;margin:40px;width:240px;height:40px" value="old">
        <div style="height:2400px"></div>
        <p id="status">Waiting</p>
        <script>
          window.pointerMoves = 0;
          window.wheelEvents = 0;
          document.addEventListener('pointermove', () => window.pointerMoves++);
          document.addEventListener('wheel', () => window.wheelEvents++);
          document.querySelector('#go').addEventListener('click', () => {
            document.querySelector('#status').textContent = 'Clicked';
          });
        </script>
      \`);
      await human.click(page.locator('#go'));
      await human.type('#name', 'Ada');
      await human.scroll(600, {steps: 6});
      return page.evaluate(() => ({
        status: document.querySelector('#status').textContent,
        value: document.querySelector('#name').value,
        pointerMoves: window.pointerMoves,
        wheelEvents: window.wheelEvents,
        scrollY,
      }));
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.status, "Clicked");
    assert.equal(result.result.value, "Ada");
    assert.ok(result.result.pointerMoves >= 18, result.result.pointerMoves);
    assert.ok(result.result.wheelEvents >= 2, result.result.wheelEvents);
    assert.ok(result.result.scrollY > 0, result.result.scrollY);
  } finally {
    await bw.close();
  }
});

test("interactive snapshots expose refs that aria-ref locators can act on", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const snap = await bw.run(`
      await page.setContent(\`
        <h1>Title</h1><p>Lots of static prose.</p>
        <button id="go">Go</button>
        <script>
          document.querySelector('#go').addEventListener('click', () => {
            document.querySelector('h1').textContent = 'Done';
          });
        </script>
      \`);
      return snapshot({interactive: true});
    `);
    assert.equal(snap.ok, true, snap.error);
    assert.match(snap.result, /button "Go" \[ref=(e\d+)\]/);
    assert.ok(!snap.result.includes("static prose"), snap.result);
    const ref = snap.result.match(/button "Go" \[ref=(e\d+)\]/)[1];
    const clicked = await bw.run(`
      await page.locator('aria-ref=${ref}').click();
      return page.locator('h1').textContent();
    `);
    assert.equal(clicked.ok, true, clicked.error);
    assert.equal(clicked.result, "Done");
  } finally {
    await bw.close();
  }
});

test("snapshot diff returns only what changed", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<button id="go">Go</button><p id="status">Idle</p>');
      const first = await snapshot({diff: true});
      const unchanged = await snapshot({diff: true});
      await page.locator('#status').evaluate(el => { el.textContent = 'Running'; });
      const changed = await snapshot({diff: true});
      return {first, unchanged, changed};
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result.first, /button "Go"/);
    assert.match(result.result.unchanged, /no changes since previous snapshot/);
    assert.match(result.result.changed, /diff vs previous snapshot \(\+\d+ -\d+\)/);
    assert.match(result.result.changed, /\+.*Running/);
    assert.ok(!result.result.changed.includes('button "Go"'), result.result.changed);
  } finally {
    await bw.close();
  }
});

test("snapshot scopes to a selector", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<nav><a href="#x">Away</a></nav><main id="m"><button>In</button></main>');
      return snapshot({selector: '#m'});
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /button "In"/);
    assert.ok(!result.result.includes("Away"), result.result);
  } finally {
    await bw.close();
  }
});

test("empty envelope collections are omitted, not sent as []", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run("return 1 + 1");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, 2);
    assert.ok(!("console" in result), "console should be omitted when empty");
    assert.ok(!("events" in result), "events should be omitted when empty");
    assert.ok(!("artifacts" in result), "artifacts should be omitted when empty");
  } finally {
    await bw.close();
  }
});

test("model code cannot reach CDP or Playwright private channels", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      return {
        pageContext: typeof page.context,
        contextCdp: typeof context.newCDPSession,
        pageChannel: typeof page._channel,
        contextBrowser: typeof context.browser,
      };
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.result, {
      pageContext: "undefined",
      contextCdp: "undefined",
      pageChannel: "undefined",
      contextBrowser: "undefined",
    });
  } finally {
    await bw.close();
  }
});

test("returned Playwright objects cannot serialize host internals", opts, async () => {
  const variable = "BETTERWRIGHT_SERIALIZER_SENTINEL";
  const sentinel = `serializer-secret-${Date.now()}`;
  const previous = process.env[variable];
  process.env[variable] = sentinel;
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const contextResult = await bw.run("return context");
    assert.equal(contextResult.ok, true, contextResult.error);
    assert.deepEqual(contextResult.result, { type: "BrowserContext" });

    const consoleResult = await bw.run(`
      const pending = page.waitForEvent('console');
      await page.evaluate(() => console.log('safe-console-event'));
      return pending;
    `);
    assert.equal(consoleResult.ok, true, consoleResult.error);
    assert.equal(consoleResult.result.type, "ConsoleMessage");
    assert.equal(consoleResult.result.level, "log");
    assert.equal(consoleResult.result.text, "safe-console-event");

    const serialized = JSON.stringify([contextResult, consoleResult]);
    assert.ok(!serialized.includes(sentinel), serialized);
    assert.doesNotMatch(
      serialized,
      /_connection|_channel|newCDPSession|executablePath|process\.env/,
    );
  } finally {
    await bw.close();
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("model navigation cannot open browser-internal control pages", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const chrome = await bw.run(
      "await page.goto('chrome://version'); return page.locator('body').innerText()",
    );
    assert.equal(chrome.ok, false);
    assert.match(chrome.error, /scheme is not available: chrome:/);
    assert.doesNotMatch(JSON.stringify(chrome), /remote-debugging|fingerprint=/i);

    const devtools = await bw.run(
      "await openPage('devtools://devtools/bundled/inspector.html'); return 'opened'",
    );
    assert.equal(devtools.ok, false);
    assert.match(devtools.error, /scheme is not available: devtools:/);
  } finally {
    await bw.close();
  }
});

test("an image-grid challenge is solvable with aria-ref tile clicks and Verify", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    // A synthetic reCAPTCHA-style grid: three "correct" tiles must be selected,
    // then Verify reveals success. Exercises the documented flow — snapshot for
    // refs, click tiles by aria-ref, click Verify — without touching a provider.
    const result = await bw.run(`
      await page.setContent(\`
        <div role="dialog" aria-label="Select all images with bicycles">
          <button aria-label="tile 0" data-correct="1"></button>
          <button aria-label="tile 1"></button>
          <button aria-label="tile 2" data-correct="1"></button>
          <button aria-label="tile 3"></button>
          <button aria-label="tile 4" data-correct="1"></button>
          <button id="verify">Verify</button>
          <p id="status" aria-live="polite">Unsolved</p>
        </div>
        <script>
          const chosen = new Set();
          for (const b of document.querySelectorAll('button[aria-label^="tile"]')) {
            b.addEventListener('click', () => { b.dataset.on = '1'; chosen.add(b); });
          }
          document.querySelector('#verify').addEventListener('click', () => {
            const correct = [...document.querySelectorAll('button[data-correct]')];
            const ok = correct.every(b => b.dataset.on === '1') &&
              [...chosen].every(b => b.dataset.correct === '1');
            document.querySelector('#status').textContent = ok ? 'Verified' : 'Try again';
          });
        </script>
      \`);
      const tree = await snapshot({interactive: true});
      const refFor = (label) =>
        (tree.match(new RegExp('"' + label + '" \\\\[ref=(e\\\\d+)\\\\]')) || [])[1];
      for (const label of ['tile 0', 'tile 2', 'tile 4']) {
        await human.click(page.locator('aria-ref=' + refFor(label)));
      }
      await human.click(page.locator('aria-ref=' + refFor('Verify')));
      return page.locator('#status').textContent();
    `);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "Verified");
  } finally {
    await bw.close();
  }
});
