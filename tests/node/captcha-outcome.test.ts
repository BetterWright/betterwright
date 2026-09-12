import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCaptchaOutcome } from "./helpers/captcha-outcome.js";

test("live CAPTCHA outcomes distinguish token receipt from tokenless ready", () => {
  assert.equal(classifyCaptchaOutcome("ready", "none", 128), "token_received");
  assert.equal(classifyCaptchaOutcome("ready", "none", 0), "unverified");
  assert.equal(classifyCaptchaOutcome("ready", "checkbox", 0), "unverified");
});

test("live CAPTCHA outcomes identify image and text vision stages without a token", () => {
  for (const stage of ["image_grid", "text"]) {
    assert.equal(classifyCaptchaOutcome("processing", stage, 0), "needs_vision");
    assert.equal(classifyCaptchaOutcome("processing", stage, 128), "token_received");
    assert.equal(classifyCaptchaOutcome("ready", stage, 0), "unverified");
  }
});

test("live CAPTCHA outcomes leave other processing stages unresolved", () => {
  for (const stage of ["checkbox", "turnstile", "managed_challenge", "invisible", "unknown", undefined]) {
    assert.equal(classifyCaptchaOutcome("processing", stage, 0), "unresolved");
  }
});

test("live CAPTCHA errors are not masked by a token or vision stage", () => {
  assert.equal(classifyCaptchaOutcome("error", "image_grid", 0), "error");
  assert.equal(classifyCaptchaOutcome("error", "none", 128), "error");
});

test("live CAPTCHA outcomes do not treat invalid token lengths as receipt", () => {
  for (const tokenLen of [-1, 0.5, NaN, Infinity]) {
    assert.equal(classifyCaptchaOutcome("ready", "none", tokenLen), "unverified");
  }
  assert.equal(classifyCaptchaOutcome("unknown", undefined, 0), "unverified");
});
