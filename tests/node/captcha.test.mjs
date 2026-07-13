import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CaptchaError, CaptchaSolver } from "../../src/captcha.mjs";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test("reads a private persisted API key", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-captcha-"));
  const keyFile = path.join(dir, "captcha-api-key");
  await fs.writeFile(keyFile, "stored-key\n", { mode: 0o600 });
  try {
    assert.equal(new CaptchaSolver({ apiKeyFile: keyFile }).apiKey, "stored-key");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("explicit empty key does not fall back to persisted configuration", () => {
  const solver = new CaptchaSolver({ apiKey: "" });
  assert.throws(() => solver._requireKey(), CaptchaError);
});

test("submits and polls a reCAPTCHA v2 task", async () => {
  const calls = [];
  const replies = [
    response('{"status":1,"request":"request-123"}'),
    response('{"status":1,"request":"solution-token"}'),
  ];
  const solver = new CaptchaSolver({
    apiKey: "test-key",
    firstPollDelayMs: 0,
    pollIntervalMs: 0,
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return replies.shift();
    },
  });
  const solution = await solver.recaptchaV2("site-key", "https://example.com");
  assert.deepEqual(solution, {
    type: "recaptcha_v2",
    token: "solution-token",
    requestId: "request-123",
  });
  assert.match(String(calls[0].options.body), /googlekey=site-key/);
  assert.match(calls[1].url, /action=get/);
});

test("balance errors do not expose the configured key", async () => {
  const solver = new CaptchaSolver({
    apiKey: "do-not-leak",
    fetch: async () => response('{"status":0,"request":"ERROR_ZERO_BALANCE"}'),
  });
  await assert.rejects(solver.balance(), (error) => {
    assert.equal(error.message, "ERROR_ZERO_BALANCE");
    assert.doesNotMatch(error.message, /do-not-leak/);
    return true;
  });
});
