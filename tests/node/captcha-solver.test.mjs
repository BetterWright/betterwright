import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSolveResult,
  CAPTCHA_SOLVE_STATUSES,
  CAPTCHA_STAGES,
  classifyChallengeStage,
  maxAutoStages,
  nextSolveAction,
  solveTimeoutMs,
} from "../../src/captcha-solver.mjs";

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
  assert.equal(maxAutoStages({ maxStages: 99 }), 5);
  assert.equal(maxAutoStages({ maxStages: 0 }), 1);
  assert.equal(solveTimeoutMs({ timeout: 100 }), 3_000);
  assert.equal(solveTimeoutMs({ timeoutMs: 500_000 }), 180_000);
});
