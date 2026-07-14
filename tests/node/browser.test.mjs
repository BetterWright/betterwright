// End-to-end Node tests. Skipped unless a Chromium build is resolvable, so the
// policy suite still runs on machines without the runtime installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
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
