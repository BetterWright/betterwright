import assert from "node:assert/strict";
import { test } from "node:test";

import { detectBotChallenge, isPublicSearchNavigation } from "../../src/challenges.mjs";

test("detects the Google unusual-traffic challenge", () => {
  const challenge = detectBotChallenge({
    url: "https://www.google.com/sorry/index?continue=search",
    text: "Our systems have detected unusual traffic from your computer network.",
  });
  assert.equal(challenge?.type, "bot_challenge");
  assert.equal(challenge?.provider, "google");
  assert.match(challenge?.advice || "", /Do not retry/i);
});

test("detects the Bing one-last-step challenge", () => {
  const challenge = detectBotChallenge({
    url: "https://www.bing.com/search?q=jacket",
    text: "One last step\nPlease solve the challenge below to continue",
  });
  assert.equal(challenge?.provider, "bing");
});

test("does not flag ordinary verification copy", () => {
  assert.equal(
    detectBotChallenge({
      url: "https://example.com/account",
      text: "Verify your email address to continue.",
    }),
    null,
  );
});

test("classifies only top-level public search URLs for pacing", () => {
  assert.equal(isPublicSearchNavigation("https://www.google.com/search?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://www.bing.com/search?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://duckduckgo.com/?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://shop.example.com/search?q=test"), false);
  assert.equal(isPublicSearchNavigation("https://www.google.com/maps?q=test"), false);
});
