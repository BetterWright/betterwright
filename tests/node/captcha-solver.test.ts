import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blobToPageBounds,
  buildSolveResult,
  CAPTCHA_SOLVE_STATUSES,
  CAPTCHA_STAGES,
  classifyChallengeStage,
  clusterSimilarBoxes,
  extractDarkBlobs,
  findGrowingRegion,
  gridFromTiles,
  inferGridTiles,
  isCaptchaChromeLabel,
  isPlausibleImageGrid,
  maxAutoStages,
  nextSolveAction,
  parseTileIndexes,
  pickBestTileSet,
  pickDragFitPair,
  pickGrowingBlob,
  publicCaptchaTiles,
  solveTimeoutMs,
  unionClip,
  visionGridInstruction,
} from "../../dist/src/captcha-solver.js";

test("classifies reCAPTCHA anchor as checkbox", () => {
  const result = classifyChallengeStage({
    main: { url: "https://shop.example/checkout" },
    frames: [
      {
        url: "https://www.google.com/recaptcha/api2/anchor?k=site-key&size=normal",
        text: "I'm not a robot",
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.CHECKBOX);
  assert.equal(result.provider, "recaptcha");
  assert.equal(result.autoSolvable, true);
  assert.equal(result.needsVision, false);
});

test("does not classify hidden dormant provider frames as active stages", () => {
  const result = classifyChallengeStage({
    main: { url: "https://shop.example/signup" },
    frames: [
      {
        url: "https://www.google.com/recaptcha/enterprise/anchor?k=site-key",
        text: "Verify you are human",
        visible: false,
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.NONE);
  assert.equal(result.autoSolvable, false);
  assert.equal(result.needsVision, false);
});

test("classifies reCAPTCHA bframe as image grid", () => {
  const result = classifyChallengeStage({
    main: { url: "https://shop.example/checkout" },
    frames: [
      {
        url: "https://www.google.com/recaptcha/api2/bframe?k=site-key",
        text: "Select all images with traffic lights",
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.IMAGE_GRID);
  assert.equal(result.provider, "recaptcha");
  assert.equal(result.needsVision, true);
  assert.equal(result.autoSolvable, false);
});

test("classifies hCaptcha challenge frame as image grid", () => {
  const result = classifyChallengeStage({
    main: { url: "https://accounts.example/sign-in" },
    frames: [
      {
        url:
          "https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html#frame=challenge",
        text: "Please click each image containing a boat",
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.IMAGE_GRID);
  assert.equal(result.provider, "hcaptcha");
});

test("classifies Turnstile widget", () => {
  const result = classifyChallengeStage({
    main: { url: "https://portal.example/login" },
    frames: [
      {
        url:
          "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0",
        text: "Verify you are human",
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.TURNSTILE);
  assert.equal(result.provider, "turnstile");
  assert.equal(result.autoSolvable, true);
});

test("classifies Cloudflare managed challenge", () => {
  const result = classifyChallengeStage({
    main: {
      url: "https://protected.example/",
      text: "Checking your browser before accessing protected.example",
    },
    frames: [
      {
        url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow/ov1/xyz",
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.MANAGED);
  assert.equal(result.autoSolvable, true);
});

test("provider frames beat host-page marketing copy about sliders", () => {
  const result = classifyChallengeStage({
    main: {
      url: "https://solver-docs.example/demo/turnstile",
      text: "We also support slider captchas, image grids, and puzzle pieces.",
    },
    frames: [
      {
        url:
          "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0",
        text: "Verify you are human",
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.TURNSTILE);
  assert.equal(result.provider, "turnstile");
});

test("classifies slider challenges from copy", () => {
  const result = classifyChallengeStage({
    url: "https://example.com/gate",
    text: "Slide the puzzle piece to complete the security check",
  });
  assert.equal(result.stage, CAPTCHA_STAGES.SLIDER);
  assert.equal(result.autoSolvable, true);
});

test("classifies text captchas", () => {
  const result = classifyChallengeStage({
    url: "https://example.com/register",
    text: "Type the characters you see in the captcha image to continue",
  });
  assert.equal(result.stage, CAPTCHA_STAGES.TEXT);
  assert.equal(result.needsVision, true);
});

test("classifies hCaptcha growing-shape copy as motion, not an image grid", () => {
  const result = classifyChallengeStage({
    main: { url: "https://accounts.hcaptcha.com/demo" },
    frames: [
      {
        url:
          "https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html#frame=challenge",
        text: "Please click on the shape that grows",
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.MOTION);
  assert.equal(result.provider, "hcaptcha");
  assert.equal(result.needsVision, false);
  assert.equal(result.autoSolvable, true);
});

test("classifies hCaptcha drag-to-fit copy as a slider from a challenge frame", () => {
  const result = classifyChallengeStage({
    main: { url: "https://accounts.hcaptcha.com/demo" },
    frames: [
      {
        url:
          "https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html#frame=challenge",
        text: "Please drag the element to the place where it fits",
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.SLIDER);
  assert.equal(result.provider, "hcaptcha");
  assert.equal(result.autoSolvable, true);
});

test("unlabeled hCaptcha challenge frames still classify as image grid", () => {
  const result = classifyChallengeStage({
    frames: [
      {
        url:
          "https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html#frame=challenge",
      },
    ],
  });
  assert.equal(result.stage, CAPTCHA_STAGES.IMAGE_GRID);
});

test("nextSolveAction maps stages to local strategies", () => {
  assert.equal(
    nextSolveAction({ stage: CAPTCHA_STAGES.CHECKBOX }).action,
    "click_checkbox",
  );
  assert.equal(
    nextSolveAction({ stage: CAPTCHA_STAGES.TURNSTILE }, 0).action,
    "click_checkbox",
  );
  assert.equal(
    nextSolveAction({ stage: CAPTCHA_STAGES.TURNSTILE }, 1).action,
    "wait_token",
  );
  assert.equal(
    nextSolveAction({ stage: CAPTCHA_STAGES.IMAGE_GRID }).action,
    "capture_tiles",
  );
  assert.equal(
    nextSolveAction({ stage: CAPTCHA_STAGES.MOTION }).action,
    "click_growing",
  );
  assert.equal(
    nextSolveAction({ stage: CAPTCHA_STAGES.SLIDER }).action,
    "drag_slider",
  );
});

test("buildSolveResult is 2Captcha-shaped and local-only", () => {
  const result = buildSolveResult({
    status: CAPTCHA_SOLVE_STATUSES.READY,
    provider: "turnstile",
    stage: CAPTCHA_STAGES.TURNSTILE,
    token: "0.abc",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.cleared, true);
  assert.equal(result.token, "0.abc");
  assert.equal(result.local, true);
  assert.equal(result.externalApi, false);
  assert.match(result.request, /^bw_/);
  assert.equal(result.request, result.requestId);
});

test("timeout and stage bounds are clamped", () => {
  // Handoff is required after at most three stages, so three is both the
  // default and the ceiling a caller can ask for.
  assert.equal(maxAutoStages({}), 3);
  assert.equal(maxAutoStages({ maxStages: 99 }), 3);
  assert.equal(maxAutoStages({ maxStages: 0 }), 1);
  assert.equal(maxAutoStages({ maxStages: 2 }), 2);
  assert.equal(solveTimeoutMs({ timeout: 100 }), 3_000);
  assert.equal(solveTimeoutMs({ timeoutMs: 500_000 }), 180_000);
});

test("parseTileIndexes accepts arrays, csv, and {index} objects", () => {
  assert.deepEqual(parseTileIndexes([0, 3, 5]), [0, 3, 5]);
  assert.deepEqual(parseTileIndexes("0, 3, 5"), [0, 3, 5]);
  assert.deepEqual(parseTileIndexes([{ index: 1 }, { index: 1 }, { index: 8 }]), [1, 8]);
  assert.deepEqual(parseTileIndexes([-1, 1.5, 99, "nope"]), []);
});

test("clusterSimilarBoxes keeps the largest same-size group in reading order", () => {
  const tiles = clusterSimilarBoxes([
    { x: 200, y: 40, width: 40, height: 20 },
    { x: 10, y: 80, width: 100, height: 100 },
    { x: 120, y: 80, width: 100, height: 100 },
    { x: 10, y: 190, width: 102, height: 98 },
    { x: 400, y: 400, width: 12, height: 12 },
  ]);
  assert.equal(tiles.length, 3);
  assert.deepEqual(
    tiles.map((box) => [box.x, box.y]),
    [
      [10, 80],
      [120, 80],
      [10, 190],
    ],
  );
});

test("gridFromTiles and inferGridTiles describe a 3x3 puzzle", () => {
  const inferred = inferGridTiles({ x: 0, y: 0, width: 300, height: 300 }, 3, 3);
  assert.equal(inferred.length, 9);
  assert.deepEqual(gridFromTiles(inferred), { rows: 3, cols: 3 });
});

test("unionClip pads tiles and stays inside the viewport", () => {
  const clip = unionClip(
    [
      { x: 40, y: 80, width: 100, height: 100 },
      { x: 150, y: 80, width: 100, height: 100 },
    ],
    { pad: 10, promptPad: 40, viewport: { width: 400, height: 300 } },
  );
  assert.equal(clip.x, 30);
  assert.equal(clip.y, 30);
  assert.ok(clip.x + clip.width <= 400);
  assert.ok(clip.y + clip.height <= 300);
});

test("visionGridInstruction tells the host to apply numbered indexes", () => {
  const text = visionGridInstruction({
    prompt: "Select all images with boats",
    grid: { rows: 3, cols: 3 },
  });
  assert.match(text, /boats/);
  assert.match(text, /3×3/);
  assert.match(text, /captcha\.solve\(\{ tiles:/);
});

test("chrome labels are not treated as image-grid tiles", () => {
  assert.equal(isCaptchaChromeLabel("EN - English, Select a language"), true);
  assert.equal(isCaptchaChromeLabel("Skip Challenge"), true);
  assert.equal(isCaptchaChromeLabel("Refresh Challenge."), true);
  assert.equal(isCaptchaChromeLabel("traffic light"), false);
  assert.equal(isCaptchaChromeLabel(""), false);
});

test("isPlausibleImageGrid rejects a 1x3 toolbar and accepts a 3x3 puzzle", () => {
  const chrome = [
    { x: 10, y: 400, width: 32, height: 32 },
    { x: 50, y: 400, width: 32, height: 32 },
    { x: 90, y: 400, width: 32, height: 32 },
  ];
  const grid = inferGridTiles({ x: 0, y: 0, width: 300, height: 300 }, 3, 3).map(
    (tile) => tile.bounds,
  );
  const photos = [
    { x: 0, y: 0, width: 160, height: 160 },
    { x: 170, y: 0, width: 160, height: 160 },
    { x: 340, y: 0, width: 160, height: 160 },
  ];
  assert.equal(isPlausibleImageGrid(chrome), false);
  assert.equal(isPlausibleImageGrid(grid), true);
  assert.equal(isPlausibleImageGrid(photos), true);
});

test("pickBestTileSet prefers a 3x3 puzzle over widget chrome", () => {
  const chrome = [
    { index: 0, bounds: { x: 10, y: 400, width: 32, height: 32 }, label: "EN" },
    { index: 1, bounds: { x: 50, y: 400, width: 32, height: 32 }, label: "Skip" },
    { index: 2, bounds: { x: 90, y: 400, width: 32, height: 32 }, label: "Refresh" },
  ];
  const grid = inferGridTiles({ x: 0, y: 0, width: 300, height: 300 }, 3, 3);
  const picked = pickBestTileSet([chrome, grid]);
  assert.equal(picked.length, 9);
  assert.equal(picked[0].bounds.width, 100);
});

test("publicCaptchaTiles flattens bounds for host vision", () => {
  const tiles = publicCaptchaTiles([
    { index: 2, bounds: { x: 10.4, y: 20.6, width: 30.2, height: 40.8 }, label: "boat" },
  ]);
  assert.deepEqual(tiles, [
    {
      index: 2,
      bounds: { x: 10, y: 21, width: 30, height: 41 },
      x: 10,
      y: 21,
      width: 30,
      height: 41,
      label: "boat",
    },
  ]);
  assert.equal(publicCaptchaTiles([]), null);
});

function paintRgba(width, height, fill = [230, 235, 240, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(fill, i * 4);
  const stamp = (cx, cy, radius, color = [30, 35, 45, 255]) => {
    const r2 = radius * radius;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) data.set(color, (y * width + x) * 4);
      }
    }
  };
  const ring = (cx, cy, outer, inner, color = [40, 40, 50, 255]) => {
    const o2 = outer * outer;
    const i2 = inner * inner;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d <= o2 && d >= i2) data.set(color, (y * width + x) * 4);
      }
    }
  };
  return { width, height, data, stamp, ring };
}

test("findGrowingRegion picks the blob whose dark area increased", () => {
  const first = paintRgba(160, 120);
  first.stamp(40, 40, 8);
  first.stamp(120, 80, 7);
  first.stamp(80, 30, 6);
  const second = paintRgba(160, 120);
  second.stamp(40, 40, 8);
  second.stamp(120, 80, 16);
  second.stamp(80, 30, 6);
  const grown = findGrowingRegion(first, second);
  assert.ok(grown);
  assert.ok(Math.abs(grown.cx - 120) < 8);
  assert.ok(Math.abs(grown.cy - 80) < 8);
  assert.ok(grown.grown >= 18);
});

test("pickGrowingBlob ignores decoys that stay the same size", () => {
  const stable = extractDarkBlobs(paintRgba(80, 80));
  assert.equal(stable.length, 0);
  const frame = paintRgba(80, 80);
  frame.stamp(20, 20, 9);
  const blobs = extractDarkBlobs(frame);
  assert.equal(blobs.length, 1);
  assert.equal(pickGrowingBlob(blobs, blobs), null);
});

test("pickDragFitPair sends the filled piece to the hollow slot", () => {
  const image = paintRgba(200, 100);
  image.stamp(40, 50, 16);
  image.ring(150, 50, 16, 11);
  const pair = pickDragFitPair(extractDarkBlobs(image));
  assert.ok(pair);
  assert.ok(pair.piece.cx < 70);
  assert.ok(pair.hole.cx > 120);
});

test("blobToPageBounds maps image pixels onto the widget CSS box", () => {
  const bounds = blobToPageBounds(
    { cx: 50, cy: 25, width: 20, height: 10 },
    { width: 100, height: 50 },
    { x: 80, y: 10, width: 200, height: 100 },
    0,
  );
  assert.equal(bounds.cx, 180);
  assert.equal(bounds.cy, 60);
  assert.equal(bounds.width, 40);
  assert.equal(bounds.height, 28);
});
