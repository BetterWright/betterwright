// End-to-end local CAPTCHA solver tests against self-hosted fixture widgets.
// These prove the in-browser solve path without third-party captcha APIs.
// Optional live demos run only when BETTERWRIGHT_LIVE_CAPTCHA=1.

import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cloakRuntime } from "../../dist/src/doctor.js";
import { BetterWright } from "../../dist/src/index.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "captcha");

const ready = (await cloakRuntime()).installed;
if (!ready && process.env.BETTERWRIGHT_REQUIRE_BROWSER) {
  throw new Error(
    "BETTERWRIGHT_REQUIRE_BROWSER is set but managed CloakBrowser is unavailable.",
  );
}
const opts = { skip: ready ? false : "browser runtime not installed" };
const liveOpts = {
  skip:
    !ready
      ? "browser runtime not installed"
      : process.env.BETTERWRIGHT_LIVE_CAPTCHA === "1"
        ? false
        : "set BETTERWRIGHT_LIVE_CAPTCHA=1 to hit public captcha demos",
};

function tempHome() {
  return makeTempDir("betterwright-captcha-");
}

async function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let file = "checkbox.html";
    if (url.pathname === "/slider") file = "slider.html";
    else if (url.pathname === "/grid") file = "grid.html";
    else if (url.pathname === "/managed") file = "managed.html";
    else if (url.pathname === "/checkbox") file = "checkbox.html";
    else if (url.pathname !== "/" && url.pathname !== "/index.html") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const body = fs.readFileSync(path.join(FIXTURES, file));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

async function withBrowser(fn) {
  const home = tempHome();
  const bw = new BetterWright({
    home,
    headless: true,
  });
  try {
    return await fn(bw);
  } finally {
    await bw.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test(
  "captcha.solve clears a local checkbox widget and mints a response token",
  opts,
  async () => {
    const server = await startFixtureServer();
    try {
      await withBrowser(async (bw) => {
        const result = await bw.run(`
          await page.goto(${JSON.stringify(`${server.base}/checkbox`)}, { waitUntil: "domcontentloaded" });
          const before = await captcha.detect();
          const solved = await captcha.solve({ timeout: 20_000, maxStages: 2 });
          const token = await page.locator('[name="bw-captcha-response"]').inputValue();
          return { before, solved, token, title: await page.title() };
        `);
        assert.equal(result.ok, true, result.error);
        assert.equal(result.result.before.present, true);
        assert.equal(result.result.solved.status, "ready");
        assert.equal(result.result.solved.cleared, true);
        assert.equal(result.result.solved.local, true);
        assert.equal(result.result.solved.externalApi, false);
        assert.ok(result.result.token.length > 8);
        assert.ok(result.result.solved.attempts.length >= 1);
      });
    } finally {
      await server.close();
    }
  },
);

test("captcha.solve drags a local slider challenge to completion", opts, async () => {
  const server = await startFixtureServer();
  try {
    await withBrowser(async (bw) => {
      const result = await bw.run(`
        await page.goto(${JSON.stringify(`${server.base}/slider`)}, { waitUntil: "domcontentloaded" });
        return captcha.solve({ timeout: 20_000, maxStages: 3 });
      `);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.result.status, "ready");
      assert.equal(result.result.cleared, true);
      assert.ok(
        result.result.attempts.some((attempt) => attempt.action === "drag_slider"),
      );
    });
  } finally {
    await server.close();
  }
});

test(
  "captcha.solve returns processing + tiles for an image grid stage",
  opts,
  async () => {
    const server = await startFixtureServer();
    try {
      await withBrowser(async (bw) => {
        const result = await bw.run(`
          await page.goto(${JSON.stringify(`${server.base}/grid`)}, { waitUntil: "domcontentloaded" });
          return captcha.solve({ timeout: 15_000, maxStages: 2 });
        `);
        assert.equal(result.ok, true, result.error);
        assert.equal(result.result.status, "processing");
        assert.equal(result.result.stage, "image_grid");
        assert.ok(Array.isArray(result.result.tiles));
        assert.ok(result.result.tiles.length >= 3);
        assert.ok(result.result.artifact?.path);
        assert.equal(result.result.local, true);
      });
    } finally {
      await server.close();
    }
  },
);

test(
  "captcha.click reuses Obscura image-grid bounds against the resident DOM",
  opts,
  async () => {
    const server = await startFixtureServer();
    try {
      await withBrowser(async (bw) => {
        const result = await bw.run(`
          await page.goto(${JSON.stringify(`${server.base}/grid`)}, { waitUntil: "domcontentloaded" });
          const solved = await captcha.solve({ timeout: 15_000, maxStages: 2 });
          for (const tile of solved.tiles.filter((entry) => entry.label === "traffic light")) {
            await captcha.click(tile.bounds);
          }
          await human.click(page.locator("#verify"));
          return page.locator('[name="bw-captcha-response"]').inputValue();
        `);
        assert.equal(result.ok, true, result.error);
        assert.match(result.result, /^bw_grid_token_/);
      });
    } finally {
      await server.close();
    }
  },
);

test(
  "captcha.solve clears a managed-style verify challenge",
  opts,
  async () => {
    const server = await startFixtureServer();
    try {
      await withBrowser(async (bw) => {
        const result = await bw.run(`
          await page.goto(${JSON.stringify(`${server.base}/managed`)}, { waitUntil: "domcontentloaded" });
          return captcha.solve({ timeout: 20_000, maxStages: 3 });
        `);
        assert.equal(result.ok, true, result.error);
        assert.equal(result.result.status, "ready");
        assert.equal(result.result.cleared, true);
      });
    } finally {
      await server.close();
    }
  },
);

test(
  "live: reCAPTCHA demo checkbox interaction (best-effort)",
  liveOpts,
  async () => {
    await withBrowser(async (bw) => {
      const result = await bw.run(`
        await page.goto("https://www.google.com/recaptcha/api2/demo", {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.waitForTimeout(2_000);
        const detected = await captcha.detect();
        const solved = await captcha.solve({ timeout: 40_000, maxStages: 3 });
        return {
          url: page.url(),
          detected,
          solved,
          hasResponse: await page.locator('textarea[name="g-recaptcha-response"]').inputValue().catch(() => ""),
        };
      `);
      assert.equal(result.ok, true, result.error);
      // Live providers may score-block automation; record structured outcome.
      assert.ok(["ready", "processing", "error"].includes(result.result.solved.status));
      assert.equal(result.result.solved.local, true);
      assert.equal(result.result.solved.externalApi, false);
      console.log(
        "[live recaptcha]",
        JSON.stringify({
          status: result.result.solved.status,
          stage: result.result.solved.stage,
          provider: result.result.solved.provider,
          attempts: result.result.solved.attempts?.length,
          tokenLen: result.result.hasResponse?.length || 0,
          present: result.result.detected?.present,
        }),
      );
    });
  },
);

test(
  "live: hCaptcha demo detection and solve attempt (best-effort)",
  liveOpts,
  async () => {
    await withBrowser(async (bw) => {
      const result = await bw.run(`
        await page.goto("https://accounts.hcaptcha.com/demo", {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.waitForTimeout(2_500);
        const detected = await captcha.detect();
        const solved = await captcha.solve({ timeout: 40_000, maxStages: 3 });
        return { detected, solved, url: page.url() };
      `);
      assert.equal(result.ok, true, result.error);
      assert.ok(["ready", "processing", "error"].includes(result.result.solved.status));
      assert.equal(result.result.solved.externalApi, false);
      console.log(
        "[live hcaptcha]",
        JSON.stringify({
          status: result.result.solved.status,
          stage: result.result.solved.stage,
          provider: result.result.solved.provider,
          widgets: result.result.detected?.widgets?.length,
        }),
      );
    });
  },
);

test(
  "live: Cloudflare Turnstile demo solve attempt (best-effort)",
  liveOpts,
  async () => {
    await withBrowser(async (bw) => {
      const result = await bw.run(`
        await page.goto("https://2captcha.com/demo/cloudflare-turnstile", {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.waitForTimeout(2_500);
        const detected = await captcha.detect();
        const solved = await captcha.solve({ timeout: 45_000, maxStages: 3 });
        const token = await page.locator('[name="cf-turnstile-response"]').inputValue().catch(() => "");
        return { detected, solved, tokenLen: token.length, url: page.url() };
      `);
      assert.equal(result.ok, true, result.error);
      assert.ok(["ready", "processing", "error"].includes(result.result.solved.status));
      assert.equal(result.result.solved.local, true);
      console.log(
        "[live turnstile]",
        JSON.stringify({
          status: result.result.solved.status,
          stage: result.result.solved.stage,
          provider: result.result.solved.provider,
          tokenLen: result.result.tokenLen,
          present: result.result.detected?.present,
        }),
      );
    });
  },
);
