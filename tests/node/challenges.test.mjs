import assert from "node:assert/strict";
import { test } from "node:test";

import { detectBotChallenge, isPublicSearchNavigation } from "../../src/challenges.mjs";

test("detects Google unusual traffic on country search domains", () => {
  const challenge = detectBotChallenge({
    main: {
      url: "https://www.google.com.sg/sorry/index?continue=search",
      text: "Our systems have detected unusual traffic from your computer network.",
    },
  });
  assert.equal(challenge?.type, "bot_challenge");
  assert.equal(challenge?.provider, "google");
  assert.equal(challenge?.detectedIn, "main");
  assert.equal(challenge?.signal, "google_unusual_traffic_text");
});

test("detects the Bing one-last-step challenge", () => {
  const challenge = detectBotChallenge({
    url: "https://www.bing.com/search?q=jacket",
    text: "One last step\nPlease solve the challenge below to continue",
  });
  assert.equal(challenge?.provider, "bing");
  assert.equal(challenge?.signal, "bing_challenge_text");
});

test("detects reCAPTCHA from child-frame metadata", () => {
  const challenge = detectBotChallenge({
    main: { url: "https://shop.example/checkout", title: "Checkout" },
    frames: [
      {
        url: "https://www.google.com/recaptcha/api2/anchor?ar=1&k=site-key&size=normal",
        text: "I'm not a robot",
      },
    ],
  });
  assert.equal(challenge?.provider, "recaptcha");
  assert.equal(challenge?.detectedIn, "frame");
  assert.equal(challenge?.challengeUrl.includes("/recaptcha/api2/anchor"), true);
  assert.equal(challenge?.url, "https://shop.example/checkout");
});

test("detects hCaptcha across provider-controlled frame subdomains", () => {
  const challenge = detectBotChallenge({
    page: { url: "https://accounts.example/sign-in" },
    childFrames: [
      {
        url:
          "https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html#frame=challenge",
      },
    ],
  });
  assert.equal(challenge?.provider, "hcaptcha");
  assert.equal(challenge?.signal, "hcaptcha_frame_url");
});

test("ignores passive hCaptcha checkbox and asset frames", () => {
  for (const url of [
    "https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html#frame=checkbox&id=widget",
    "https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html",
  ]) {
    assert.equal(
      detectBotChallenge({
        main: { url: "https://accounts.example/sign-in" },
        frames: [{ url }],
      }),
      null,
    );
  }
});

test("detects hCaptcha task UI when an active frame omits its frame marker", () => {
  const challenge = detectBotChallenge({
    main: { url: "https://accounts.example/sign-in" },
    frames: [
      {
        url: "https://newassets.hcaptcha.com/captcha/v1/build/static/hcaptcha.html",
        text: "Please select all images containing a bicycle",
      },
    ],
  });
  assert.equal(challenge?.provider, "hcaptcha");
  assert.equal(challenge?.signal, "hcaptcha_frame_url");
});

test("detects Turnstile from a Cloudflare challenge frame", () => {
  const challenge = detectBotChallenge({
    mainPage: { url: "https://portal.example/login" },
    frames: [
      {
        url:
          "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0",
        text: "Verify you are human",
      },
    ],
  });
  assert.equal(challenge?.provider, "turnstile");
  assert.equal(challenge?.signal, "turnstile_frame_url");
});

test("completed provider response fields clear persistent widget frames", () => {
  for (const [provider, url] of [
    ["recaptcha", "https://www.google.com/recaptcha/api2/anchor?k=site-key"],
    [
      "hcaptcha",
      "https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html#frame=challenge",
    ],
    [
      "turnstile",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0",
    ],
  ]) {
    assert.equal(
      detectBotChallenge({
        main: { url: "https://example.com/form" },
        frames: [{ url, text: "Verify you are human" }],
        solvedProviders: [provider],
      }),
      null,
    );
  }
});

test("completed or solved search-provider pages do not remain challenged", () => {
  assert.equal(
    detectBotChallenge({
      main: {
        url: "https://www.google.com/search?q=example",
        text: "Our systems have detected unusual traffic from your computer network.",
        completed: true,
      },
    }),
    null,
  );
  assert.equal(
    detectBotChallenge({
      main: {
        url: "https://www.bing.com/search?q=example",
        text: "One last step. Please solve the challenge below to continue.",
      },
      solvedProviders: ["bing"],
    }),
    null,
  );
});

test("frame completion is scoped to one widget", () => {
  const url = "https://www.google.com/recaptcha/api2/anchor?k=site-key";
  assert.equal(
    detectBotChallenge({
      main: { url: "https://example.com/form" },
      frames: [{ url, text: "I'm not a robot", completed: true }],
    }),
    null,
  );

  const challenge = detectBotChallenge({
    main: { url: "https://example.com/form" },
    frames: [
      { url: `${url}&id=first`, completed: true },
      { url: `${url}&id=second`, text: "I'm not a robot" },
    ],
  });
  assert.equal(challenge?.provider, "recaptcha");
  assert.equal(challenge?.challengeUrl.includes("id=second"), true);
});

test("detects a concise generic verify-human prompt", () => {
  const challenge = detectBotChallenge({
    url: "https://security.example/check",
    title: "Security check",
    text: "Please verify that you are a human to continue.",
  });
  assert.equal(challenge?.provider, "security.example");
  assert.equal(challenge?.signal, "verify_human_text");
});

test("normalizes typographic apostrophes in generic robot prompts", () => {
  const challenge = detectBotChallenge({
    url: "https://security.example/check",
    text: "I’m not a robot",
  });
  assert.equal(challenge?.provider, "recaptcha");
  assert.equal(challenge?.signal, "verify_human_text");
});

test("returns bounded solve, verify, and resume advice", () => {
  const challenge = detectBotChallenge({
    url: "https://example.com/check",
    text: "Verify you are human",
  });
  assert.equal(challenge?.solve.maxAttempts, 3);
  assert.equal(challenge?.solve.resumeOnClear, true);
  assert.deepEqual(challenge?.solve.helpers, [
    "captcha.solve",
    "captcha.detect",
    "captcha.inspect",
    "captcha.click",
    "captcha.drag",
    "captcha.readText",
    "human.click",
  ]);
  assert.match(challenge?.advice || "", /three distinct stages/i);
  assert.match(challenge?.advice || "", /resume the original action/i);
  assert.match(challenge?.advice || "", /never repeat the same failed action/i);
});

test("does not flag ordinary identity or email verification copy", () => {
  assert.equal(
    detectBotChallenge({
      url: "https://example.com/account",
      text: "Verify your email address to continue. We verify you are human during review.",
    }),
    null,
  );
});

test("does not treat documentation text or unrelated URL parameters as a challenge", () => {
  assert.equal(
    detectBotChallenge({
      url: "https://docs.example/captcha?example=/recaptcha/api2/anchor",
      title: "Integrating reCAPTCHA",
      text:
        "This guide explains that reCAPTCHA widgets can display an I'm not a robot checkbox.",
    }),
    null,
  );
  assert.equal(
    detectBotChallenge({
      url: "https://docs.example/integrations/turnstile/widget",
      text: "Widget API reference",
    }),
    null,
  );
});

test("ignores explicitly invisible provider frames without a blocking prompt", () => {
  for (const url of [
    "https://www.google.com/recaptcha/api2/anchor?k=key&size=invisible",
    "https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html#frame=checkbox-invisible",
    "https://challenges.cloudflare.com/turnstile/v0/widget?size=invisible",
  ]) {
    assert.equal(
      detectBotChallenge({
        main: { url: "https://example.com/form" },
        frames: [{ url }],
      }),
      null,
    );
  }
});

test("uses visible frame text to report an interactive challenge from an invisible widget", () => {
  for (const [url, provider] of [
    ["https://www.google.com/recaptcha/api2/anchor?k=key&size=invisible", "recaptcha"],
    [
      "https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html#frame=checkbox-invisible",
      "hcaptcha",
    ],
    ["https://challenges.cloudflare.com/turnstile/v0/widget?size=invisible", "turnstile"],
  ]) {
    const challenge = detectBotChallenge({
      main: { url: "https://example.com/form" },
      frames: [{ url, text: "Verify you are human" }],
    });
    assert.equal(challenge?.provider, provider);
    assert.equal(challenge?.detectedIn, "frame");
  }
});

test("classifies only top-level public search URLs for pacing", () => {
  assert.equal(isPublicSearchNavigation("https://www.google.com/search?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://www.google.co.uk/search/?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://www.bing.com/search?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://www.bing.com/images/search?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://www.bing.com/videos/search/?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://www.bing.com/news/search?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://duckduckgo.com/?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://duckduckgo.com/html/?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://lite.duckduckgo.com/lite/?q=test"), true);
  assert.equal(isPublicSearchNavigation("https://shop.example.com/search?q=test"), false);
  assert.equal(isPublicSearchNavigation("https://www.google.com/maps?q=test"), false);
  assert.equal(isPublicSearchNavigation("https://www.bing.com/maps?q=test"), false);
  assert.equal(isPublicSearchNavigation("https://lite.duckduckgo.com/about"), false);
  assert.equal(isPublicSearchNavigation("not a URL"), false);
});
