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
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
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
  child.kill("SIGTERM");
  throw new Error(`External Chromium did not start at ${endpoint}.`);
}

async function closeExternalChromium(runtime) {
  if (runtime.child.exitCode === null) runtime.child.kill("SIGTERM");
  if (runtime.child.exitCode === null)
    await Promise.race([
      once(runtime.child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  fs.rmSync(runtime.profileDir, { recursive: true, force: true });
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

test("attach mode can drive an externally launched Chromium", opts, async () => {
  const runtime = await externalChromium();
  const bw = new BetterWright({
    home: path.join(runtime.profileDir, "betterwright"),
    connectOverCdp: runtime.endpoint,
  });
  try {
    const result = await bw.run(
      "await page.goto('https://example.com'); return page.title()",
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result, "Example Domain");
    assert.equal(result.profileMode, "attached");
  } finally {
    await bw.close();
    await closeExternalChromium(runtime);
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

test("visible bot challenges are reported without bypassing them", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(
      "await page.setContent('<h1>One last step</h1><p>Please solve the challenge below to continue</p>'); return 'loaded'",
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.challenges?.[0]?.type, "bot_challenge");
    assert.match(result.warnings?.[0] || "", /Do not retry/i);
  } finally {
    await bw.close();
  }
});

test("captcha.click activates a checkbox-style challenge and returns a fresh snapshot", opts, async () => {
  const bw = new BetterWright({ home: tempHome(), headless: true });
  try {
    const result = await bw.run(`
      await page.setContent('<button id="verify">Verify you are human</button>');
      await page.locator('#verify').evaluate(element => {
        element.addEventListener('click', () => { element.textContent = 'Verified'; });
      });
      const bounds = await page.locator('#verify').boundingBox();
      return captcha.click(bounds);
    `);
    assert.equal(result.ok, true, result.error);
    assert.match(result.result, /Verified/);
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
