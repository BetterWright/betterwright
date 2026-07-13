import assert from "node:assert/strict";
import { test } from "node:test";

import { chromeExecutableCandidates, findChromeExecutable } from "../../src/chrome.mjs";

test("Chrome candidate paths are platform-specific", () => {
  assert.ok(chromeExecutableCandidates("darwin")[0].includes("Google Chrome.app"));
  assert.ok(chromeExecutableCandidates("win32")[0].endsWith("chrome.exe"));
  assert.ok(chromeExecutableCandidates("linux")[0].includes("google-chrome"));
});

test("an explicit missing Chrome path is not accepted", () => {
  assert.notEqual(findChromeExecutable("/definitely/missing/chrome"), "/definitely/missing/chrome");
});
