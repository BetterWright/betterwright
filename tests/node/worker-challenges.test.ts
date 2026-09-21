import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import vm from "node:vm";

import {
  captchaBounds,
  captchaGridSignature,
  captchaPoint,
  createCaptchaRuntime,
  drawCaptchaTileOverlay,
  sampleCanvasRgbaInPage,
} from "../../dist/src/captcha-runtime.js";
import {
  collectChallengeMetadata,
  createChallengeScanner,
  markChallengesForWorkerRestart,
  readFramePresentationInPage,
  readFrameWalkInPage,
  readSolvedProvidersInPage,
} from "../../dist/src/challenge-scan.js";

function pageFixture({ text = "Ordinary content", tokens = {}, closed = false } = {}) {
  const page = {
    url: () => "https://example.com/checkout",
    title: async () => "Checkout",
    isClosed: () => closed,
    frames: () => [page],
    mainFrame: () => page,
    locator: () => ({ innerText: async () => text }),
    evaluate: async (fn) => fn === readSolvedProvidersInPage
      ? tokens
      : { iframes: [], sameOrigin: [] },
  };
  return page;
}

function sessionFixture(page?) {
  return {
    currentId: page ? "p1" : null,
    pages: new Map(page ? [["p1", page]] : []),
    artifacts: [],
    openChallengeProviders: new Set(["recaptcha"]),
    cursor: { x: 0, y: 0, initialized: false },
    captchaTargets: new Map(),
    captchaGrid: null,
  };
}

test("challenge modules import without worker process wiring or output", () => {
  const modules = [
    new URL("../../dist/src/challenge-scan.js", import.meta.url).href,
    new URL("../../dist/src/captcha-runtime.js", import.meta.url).href,
  ];
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const before = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"]
      .map((event) => process.listenerCount(event));
    const stdinBefore = process.stdin.listenerCount("data");
    for (const url of ${JSON.stringify(modules)}) await import(url);
    const after = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"]
      .map((event) => process.listenerCount(event));
    if (JSON.stringify(before) !== JSON.stringify(after)) process.exitCode = 2;
    if (stdinBefore !== process.stdin.listenerCount("data")) process.exitCode = 3;
  `], { encoding: "utf8", timeout: 5_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("bounds and points preserve numeric coercion and validation", () => {
  assert.deepEqual(captchaBounds({ x: "3", y: -2, width: "9", height: 8 }), {
    x: 3, y: -2, width: 9, height: 8,
  });
  assert.deepEqual(captchaPoint({ x: null, y: "4" }, "drag start"), { x: 0, y: 4 });
  for (const width of [0, -1, Infinity, NaN]) {
    assert.throws(() => captchaBounds({ x: 0, y: 0, width, height: 8 }), /positive dimensions/);
  }
  assert.throws(() => captchaBounds(null, "target"), /captcha target requires/);
  assert.throws(() => captchaPoint({ x: 1 }, "drag end"), /captcha drag end requires/);
});

test("grid signatures preserve page coordinates, rounding, and tile order", () => {
  const first = [{ bounds: { x: 10.2, y: 20.4, width: 30.4, height: 40.7 } }];
  assert.equal(captchaGridSignature(first), "10,20,30,41");
  assert.equal(captchaGridSignature(first, { x: 5, y: 100 }), "15,120,30,41");
  assert.equal(captchaGridSignature([]), "");
  assert.equal(captchaGridSignature([{ bounds: {} }, ...first]), "0,0,0,0|10,20,30,41");
});

test("restart advice copies challenges without mutating the prior result", () => {
  const original = {
    url: "https://example.com/checkout",
    provider: "recaptcha",
    solve: { resumeOnClear: true, maxStages: 3 },
  };
  const [restarted] = markChallengesForWorkerRestart([original]);
  assert.deepEqual(original.solve, { resumeOnClear: true, maxStages: 3 });
  assert.deepEqual(restarted.solve, {
    resumeOnClear: false, maxStages: 3, reopenRequired: true,
  });
  assert.deepEqual(restarted.recovery, { pagePreserved: false, reopenUrl: original.url });
  assert.match(restarted.advice, /reopen the reported URL/);
});

test("serialized solved-provider callback needs no host imports and requires all fields", () => {
  const fields = new Map([
    ['[name="g-recaptcha-response"]', [{ value: " first " }, { value: "" }]],
    ['[name="h-captcha-response"]', [{ value: " solved " }]],
    ['[name="bw-captcha-response"]', [{ value: 9 }]],
  ]);
  const read = () => JSON.parse(JSON.stringify(vm.runInNewContext(
    `(${readSolvedProvidersInPage.toString()})()`,
    { document: { querySelectorAll: (selector) => fields.get(selector) || [] } },
  )));
  assert.deepEqual(read(), { hcaptcha: "solved" });
  fields.set('[name="g-recaptcha-response"]', [{ value: " first " }, { value: "second" }]);
  assert.deepEqual(read(), { recaptcha: "first", hcaptcha: "solved" });
});

test("serialized geometry, walk, overlay, and canvas callbacks are self-contained", () => {
  const element = {
    getBoundingClientRect: () => ({ width: 80, height: 40 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ opacity: "0" }) } },
  };
  const presentation = vm.runInNewContext(`(${readFramePresentationInPage.toString()})(element)`, { element });
  assert.equal(presentation.visible, false);
  assert.equal(presentation.width, 80);
  const walk = vm.runInNewContext(`(${readFrameWalkInPage.toString()})(options)`, {
    performance: { now: () => 0 },
    document: { querySelectorAll: () => [] },
    options: { walkBudgetMs: 250, frameLimit: 24, wantFrameText: true },
  });
  assert.equal(walk.iframes.length, 0);
  assert.equal(walk.sameOrigin.length, 0);
  const appended = [];
  vm.runInNewContext(`(${drawCaptchaTileOverlay.toString()})({ tiles: [], overlayId: "tiles" })`, {
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {} }),
      body: { appendChild: (node) => appended.push(node) },
    },
  });
  assert.equal(appended[0].id, "tiles");
  assert.equal(vm.runInNewContext(`(${sampleCanvasRgbaInPage.toString()})(null, 200)`), null);
});

test("metadata gate retains solved tokens while skipping child-frame scans", async () => {
  const page = pageFixture({ tokens: { recaptcha: "done" } });
  const child = pageFixture();
  child.url = () => "https://frame.example/";
  child.locator = () => { throw new Error("child-frame scan must be skipped"); };
  page.frames = () => [page, child];
  let gateCalls = 0;
  const result = await collectChallengeMetadata(page, {
    gate: ({ childFrames, tokens }) => {
      gateCalls += 1;
      assert.equal(childFrames.length, 1);
      assert.equal(tokens.recaptcha, "done");
      return false;
    },
  });
  assert.equal(gateCalls, 1);
  assert.deepEqual(result.frames, []);
  assert.deepEqual(result.solvedProviders, ["recaptcha"]);
  assert.equal(result.main.text, "Ordinary content");
});

test("reporting clears providers only after a completed scan", async () => {
  const { detectSessionChallenges } = createChallengeScanner({
    captureScreenshot: async () => { throw new Error("unexpected screenshot"); },
    pageId: () => "p1",
    lastBlockedDocumentAt: () => 0,
  });
  const absent = sessionFixture();
  assert.deepEqual(await detectSessionChallenges(absent), []);
  assert.deepEqual([...absent.openChallengeProviders], ["recaptcha"]);
  const ordinary = sessionFixture(pageFixture());
  assert.deepEqual(await detectSessionChallenges(ordinary), []);
  assert.equal(ordinary.openChallengeProviders.size, 0);
});

test("reporting survives screenshot failure and still tracks the open provider", async () => {
  const page = pageFixture({
    text: "Our systems have detected unusual traffic from your computer network.",
  });
  page.url = () => "https://www.google.com/sorry/index";
  const session = sessionFixture(page);
  const { detectSessionChallenges } = createChallengeScanner({
    captureScreenshot: async () => { throw new Error("page closed during capture"); },
    pageId: () => "p1",
    lastBlockedDocumentAt: () => 0,
  });
  const challenges = await detectSessionChallenges(session);
  assert.equal(challenges.length, 1);
  assert.equal(challenges[0].pageId, "p1");
  assert.equal(session.artifacts.length, 0);
  assert.deepEqual([...session.openChallengeProviders], [challenges[0].provider]);
});

test("solver returns an existing token before interaction or screenshot work", async () => {
  const page = pageFixture({ tokens: { recaptcha: "done" } });
  const { solveCaptchaOnPage, clickStoredTiles } = createCaptchaRuntime({
    captureScreenshot: async () => { throw new Error("unexpected screenshot"); },
  });
  const session = sessionFixture(page);
  const result = await solveCaptchaOnPage(page, session);
  assert.equal(result.status, "ready");
  assert.equal(result.cleared, true);
  assert.equal(result.token, "done");
  assert.deepEqual(result.attempts, []);
  assert.deepEqual(await clickStoredTiles(page, session, [0]), {
    ok: false, reason: "tiles_not_captured",
  });
});
