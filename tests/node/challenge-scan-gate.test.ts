// The staged challenge scan: the per-frame walk costs a round trip per frame,
// so it runs only when `challengeScanNeeded` says something already points at a
// challenge. That makes the gate a detection surface — a gate narrower than the
// detector is a silent false negative — so these tests pin it against
// `detectBotChallenge` itself rather than against a hand-copied pattern list.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHALLENGE_BLOCK_WINDOW_MS,
  CHALLENGE_UNREAD_FRAME_BUDGET,
  challengeScanNeeded,
  detectBotChallenge,
  frameUrlLooksLikeChallenge,
} from "../../dist/src/challenges.js";

const BENIGN_MAIN = {
  url: "https://shop.example/checkout",
  title: "Checkout",
  text: "Review your order and choose a shipping method.",
};

// Every URL family `challengeUrlSignal` recognizes, written the way the real
// providers serve them. The gate must accept all of these.
const PROVIDER_URLS = [
  // google /sorry, on .com and the country-code domains isGoogleHost accepts
  "https://www.google.com/sorry/index?continue=https://www.google.com/search",
  "https://google.com/sorry",
  "https://www.google.com.sg/sorry/index?continue=search",
  "https://www.google.co.uk/sorry/index",
  "https://www.google.de/sorry/index",
  "https://ipv4.google.com/sorry/index",
  // bing challenge paths
  "https://www.bing.com/captcha/challenge?id=1",
  "https://www.bing.com/challenge",
  "https://www.bing.com/turing/captcha/challenge",
  // recaptcha anchor/bframe on both google and recaptcha.net
  "https://www.google.com/recaptcha/api2/anchor?ar=1&k=site-key&size=normal",
  "https://www.google.com/recaptcha/api2/bframe?hl=en&k=site-key",
  "https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=site-key",
  "https://www.google.com/recaptcha/enterprise/bframe?k=site-key",
  "https://www.recaptcha.net/recaptcha/api2/anchor?k=site-key",
  "https://recaptcha.net/recaptcha/enterprise/bframe?k=site-key",
  // invisible reCAPTCHA: the detector suppresses it, the gate must still allow
  // the scan that would decide that
  "https://www.google.com/recaptcha/api2/anchor?k=site-key&size=invisible",
  // hcaptcha frames
  "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha-challenge.html#frame=challenge",
  "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge",
  "https://hcaptcha.com/challenge",
  "https://assets.hcaptcha.com/captcha/v1/abc/static/hcaptcha-checkbox.html",
  // turnstile + the cdn-cgi challenge platform, which any site may serve
  "https://challenges.cloudflare.com/turnstile/v0/api.js",
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x",
  "https://challenges.cloudflare.com/",
  "https://shop.example/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1",
];

// Shapes that look like a provider to a substring check but are not one. A gate
// that fires on these pays the full frame walk on ordinary ad-heavy pages,
// which is the entire cost the staging exists to avoid.
const BENIGN_URLS = [
  "https://example.com/cdn-cgi-fake/challenge-platform/x",
  "https://example.com/cdn-cgi/challenge-platform-fake/x",
  "https://recaptcha.example.com/recaptcha/api2/anchor?k=1",
  "https://hcaptcha.com.evil.test/challenge",
  "https://challenges.cloudflare.com.evil.test/turnstile/v0/api.js",
  "https://notgoogle.com/sorry/index",
  "https://google.com.evil.test/sorry/index",
  "https://notbing.com/captcha/challenge",
  "https://example.com/turnstile/widget",
  "https://example.com/sorry/index",
  "https://www.google.com/search?q=jacket",
  "https://www.google.com/recaptcha/api.js?render=site-key",
  "https://www.google.com/recaptcha/api2/reload?k=site-key",
  "https://www.bing.com/search?q=jacket",
  "https://td.doubleclick.net/td/ga/rul?tid=G-1",
  "https://www.youtube.com/embed/abc",
  "https://static.example.com/ads/iframe.html",
  "about:blank",
  "",
  "not a url",
];

// Frames that carry no challenge shape at all: ad, analytics and embed URLs,
// plus the provider lookalikes that are not challenge-shaped either. More than
// CHALLENGE_UNREAD_FRAME_BUDGET of them, so the budget rule is not what makes a
// list of these skip the scan.
const ORDINARY_FRAME_URLS = [
  "https://td.doubleclick.net/td/ga/rul?tid=G-1",
  "https://www.youtube.com/embed/abc",
  "https://static.example.com/ads/iframe.html",
  "https://recaptcha.example.com/recaptcha/api2/anchor?k=1",
  "https://challenges.cloudflare.com.evil.test/turnstile/v0/api.js",
  "https://google.com.evil.test/sorry/index",
  "https://example.com/turnstile/widget",
  "https://www.google.com/recaptcha/api.js?render=site-key",
  "https://www.google.com/recaptcha/api2/reload?k=site-key",
  "about:blank",
  "",
];

// Cross-origin frames whose URL names no provider `challengeUrlSignal` knows,
// but whose host or path is challenge-shaped. Their text is the only thing that
// could identify them and reading it costs a round trip, so the gate has to
// open on the URL alone.
const CHALLENGE_LIKE_URLS = [
  "https://geo.captcha-delivery.com/captcha/?initialCid=x", // DataDome
  "https://client-api.arkoselabs.com/fc/gt2/public_key/ABC", // Arkose / FunCaptcha
  "https://us-east-1.captcha.awswaf.com/captcha.html", // AWS WAF
  "https://captcha.px-cdn.net/w/abc", // PerimeterX / HUMAN
  "https://api.geetest.com/gettype.php",
  "https://verify.shop-cdn.example/gate.html", // self-hosted, vendor unknown
  "https://verify.example.com/challenge",
  "https://shop.example/security/verify.html",
  "https://cdn.example/bot-check/index.html",
];

// A cross-origin frame is opaque to the stage-1 evaluate, so all the gate ever
// learns about one is its URL — which is what `readable: false` records.
function urlFrames(urls) {
  return urls.map((url) => ({ url, readable: false }));
}

// The same-origin frames stage 1 could read in full.
function readFrames(entries) {
  return entries.map((entry) => ({ ...entry, readable: true }));
}

test("the gate accepts every provider URL family the detector recognizes", () => {
  for (const url of PROVIDER_URLS) {
    assert.equal(
      frameUrlLooksLikeChallenge(url),
      true,
      `frameUrlLooksLikeChallenge must accept ${url}`,
    );
  }
});

test("the gate rejects provider lookalikes", () => {
  for (const url of BENIGN_URLS) {
    assert.equal(
      frameUrlLooksLikeChallenge(url),
      false,
      `frameUrlLooksLikeChallenge must reject ${url}`,
    );
  }
});

// The load-bearing invariant: the gate may be broader than the detector but
// never narrower. Asserted against the detector's own answer so the two cannot
// drift when a provider pattern is added to only one of them.
test("no URL the detector matches from a frame is rejected by the gate", () => {
  for (const url of [...PROVIDER_URLS, ...BENIGN_URLS]) {
    const detected = detectBotChallenge({
      main: BENIGN_MAIN,
      frames: [{ url, visible: true }],
    });
    if (detected?.detectedIn !== "frame") continue;
    assert.equal(
      frameUrlLooksLikeChallenge(url),
      true,
      `the detector matched ${url} from its URL but the gate would skip the scan`,
    );
  }
});

test("a provider frame URL asks for the full scan", () => {
  for (const url of PROVIDER_URLS) {
    assert.equal(
      challengeScanNeeded({
        openProviders: new Set(),
        main: BENIGN_MAIN,
        frames: urlFrames(["https://static.example.com/ads/iframe.html", url]),
        solvedProviders: [],
      }),
      true,
      `a ${url} frame must trigger the frame scan`,
    );
  }
});

test("a provider URL in the main frame asks for the full scan", () => {
  assert.equal(
    challengeScanNeeded({
      openProviders: new Set(),
      main: { url: "https://www.google.com/sorry/index", title: "", text: "" },
      frames: [],
    }),
    true,
  );
});

test("benign frames and clean main text skip the full scan", () => {
  assert.equal(
    challengeScanNeeded({
      openProviders: new Set(),
      blockedAt: 0,
      now: 1_700_000_000_000,
      main: BENIGN_MAIN,
      frames: urlFrames(ORDINARY_FRAME_URLS),
      solvedProviders: [],
    }),
    false,
  );
});

// The class the URL-only gate would otherwise lose: a cross-origin challenge
// frame served by a vendor `challengeUrlSignal` does not name, or by the site
// itself. The old unconditional scan caught these on frame text alone.
test("a challenge-shaped frame URL asks for the full scan", () => {
  for (const url of CHALLENGE_LIKE_URLS) {
    assert.equal(
      challengeScanNeeded({
        openProviders: new Set(),
        blockedAt: 0,
        now: 1_700_000_000_000,
        main: BENIGN_MAIN,
        frames: urlFrames([...ORDINARY_FRAME_URLS, url]),
        solvedProviders: [],
      }),
      true,
      `an unread ${url} frame must trigger the frame scan`,
    );
  }
  // None of them is reported as a provider by the detector's URL rules: the
  // gate is allowed to be broader, and here it has to be.
  for (const url of CHALLENGE_LIKE_URLS) {
    assert.equal(frameUrlLooksLikeChallenge(url), false, url);
  }
});

// URL shape is only the fallback. A handful of unread frames are read outright,
// because the scan that reads them costs less than the round trips the gate
// saves on the pages that have none.
test("a few unread frames are scanned whatever their URL says", () => {
  const state = {
    openProviders: new Set(),
    blockedAt: 0,
    now: 1_700_000_000_000,
    main: BENIGN_MAIN,
    solvedProviders: [],
  };
  const opaque = "https://cdn.partner.example/w/9f3.html";
  for (let count = 1; count <= CHALLENGE_UNREAD_FRAME_BUDGET; count += 1) {
    assert.equal(
      challengeScanNeeded({ ...state, frames: urlFrames(Array(count).fill(opaque)) }),
      true,
      `${count} unread frames must be read rather than guessed at`,
    );
  }
  // Past the budget the frames are judged on URL shape alone. This is the one
  // accepted narrowing against the old unconditional scan.
  assert.equal(
    challengeScanNeeded({
      ...state,
      frames: urlFrames(Array(CHALLENGE_UNREAD_FRAME_BUDGET + 1).fill(opaque)),
    }),
    false,
  );
  // A frame stage 1 already read in full does not count as unread, however
  // many of them there are.
  assert.equal(
    challengeScanNeeded({
      ...state,
      frames: readFrames([
        { url: "https://shop.example/cart", title: "Cart", text: "2 items", visible: true },
      ]),
    }),
    false,
  );
  // Nor does one the caller knows to be invisible — the detector drops those.
  assert.equal(
    challengeScanNeeded({
      ...state,
      frames: [{ url: opaque, readable: false, visible: false }],
    }),
    false,
  );
});

test("a main document that is itself the interstitial asks for the full scan", () => {
  // Cloudflare and Google replace the page and carry no provider frame at all,
  // so nothing but the stage-1 title and text points at the challenge.
  assert.equal(
    challengeScanNeeded({
      openProviders: new Set(),
      main: {
        url: "https://shop.example/checkout",
        title: "Just a moment...",
        text: "Checking your browser before accessing shop.example.",
      },
      frames: [],
    }),
    true,
  );
  assert.equal(
    challengeScanNeeded({
      openProviders: new Set(),
      main: {
        url: "https://www.google.com/search?q=jacket",
        title: "",
        text: "Our systems have detected unusual traffic from your computer network.",
      },
      frames: [],
    }),
    true,
  );
});

test("an unresolved challenge from the previous scan forces the full scan", () => {
  const state = {
    openProviders: new Set(["recaptcha"]),
    blockedAt: 0,
    now: 1_700_000_000_000,
    main: BENIGN_MAIN,
    frames: urlFrames(ORDINARY_FRAME_URLS),
    solvedProviders: [],
  };
  assert.equal(challengeScanNeeded(state), true);
  // An array of providers reads the same as a Set: the gate must not depend on
  // which collection the caller keeps its open providers in.
  assert.equal(challengeScanNeeded({ ...state, openProviders: ["recaptcha"] }), true);
  assert.equal(challengeScanNeeded({ ...state, openProviders: new Set() }), false);
  assert.equal(challengeScanNeeded({ ...state, openProviders: [] }), false);
});

test("a recent blocked main document forces the full scan until the window lapses", () => {
  const now = 1_700_000_000_000;
  const base = {
    openProviders: new Set(),
    now,
    main: BENIGN_MAIN,
    frames: [],
    solvedProviders: [],
  };
  assert.equal(challengeScanNeeded({ ...base, blockedAt: now }), true);
  assert.equal(challengeScanNeeded({ ...base, blockedAt: now - 1 }), true);
  assert.equal(
    challengeScanNeeded({ ...base, blockedAt: now - CHALLENGE_BLOCK_WINDOW_MS }),
    true,
  );
  assert.equal(
    challengeScanNeeded({ ...base, blockedAt: now - CHALLENGE_BLOCK_WINDOW_MS - 1 }),
    false,
  );
  // No block ever recorded: the epoch-zero default must not read as "just now".
  assert.equal(challengeScanNeeded({ ...base, blockedAt: 0 }), false);
  assert.equal(challengeScanNeeded(base), false);
});

test("a solved provider stops the main-frame text from forcing the scan", () => {
  // The prompt names reCAPTCHA, so a filled `g-recaptcha-response` is the same
  // provider the detector would have reported.
  const main = {
    url: "https://shop.example/checkout",
    title: "Checkout",
    text: "I'm not a robot",
  };
  assert.equal(challengeScanNeeded({ openProviders: new Set(), main, frames: [] }), true);
  assert.equal(
    challengeScanNeeded({
      openProviders: new Set(),
      main,
      frames: [],
      solvedProviders: ["recaptcha"],
    }),
    false,
  );
});

// Self-hosted and srcdoc challenge frames name no provider in their URL, so
// text is the only thing that identifies them. Stage 1 can read that text for
// same-origin frames without a round trip, and the gate has to use it — this is
// what keeps `iframe-only bot challenges are detected` true.
test("a same-origin frame's text asks for the full scan on its own", () => {
  const state = {
    openProviders: new Set(),
    blockedAt: 0,
    now: 1_700_000_000_000,
    main: { url: "about:blank", title: "", text: "" },
    solvedProviders: [],
  };
  assert.equal(
    challengeScanNeeded({
      ...state,
      frames: readFrames([
        { url: "about:srcdoc", title: "", text: "Verify you are human", visible: true },
      ]),
    }),
    true,
  );
  assert.equal(
    challengeScanNeeded({
      ...state,
      frames: readFrames([
        {
          url: "https://shop.example/gate",
          title: "",
          text: "Press and hold to confirm you are human",
          visible: true,
        },
      ]),
    }),
    true,
  );
  // Ordinary same-origin frames still skip the scan.
  assert.equal(
    challengeScanNeeded({
      ...state,
      frames: readFrames([
        { url: "https://shop.example/cart-widget", title: "Cart", text: "2 items, $40", visible: true },
      ]),
    }),
    false,
  );
  // An offscreen frame is not a challenge the user can be blocked by, which is
  // the same rule the full scan applies.
  assert.equal(
    challengeScanNeeded({
      ...state,
      frames: readFrames([
        { url: "about:srcdoc", title: "", text: "Verify you are human", visible: false },
      ]),
    }),
    false,
  );
});

test("the gate survives absent, partial, and hostile state", () => {
  assert.equal(challengeScanNeeded(), false);
  assert.equal(challengeScanNeeded(null), false);
  assert.equal(challengeScanNeeded("nope"), false);
  assert.equal(challengeScanNeeded({}), false);
  assert.equal(challengeScanNeeded({ frames: "not-an-array" }), false);
  assert.equal(challengeScanNeeded({ main: null, frames: [null, undefined, 7] }), false);
  assert.equal(challengeScanNeeded({ openProviders: new Set(["x"]) }), true);
});

// The compatibility question that matters is whether skipping stage 2 loses a
// challenge the *unconditional* scan would have reported — so the comparison is
// against the full frame metadata that scan produced, while the gate is fed
// only what production can give it: text and visibility for same-origin frames,
// a bare URL for cross-origin ones.
//
// One escape is allowed, and the test pins its exact shape rather than hiding
// it: a page carrying more than CHALLENGE_UNREAD_FRAME_BUDGET unread frames
// whose URLs say nothing, where one of them turns out to hold the challenge.
// Everything else must agree.
test("skipping the scan only ever loses an over-budget unread frame", () => {
  const mains = [
    BENIGN_MAIN,
    { url: "https://shop.example/", title: "Just a moment...", text: "Checking your browser before accessing shop.example." },
    { url: "https://www.bing.com/search?q=a", title: "One last step", text: "Please solve the challenge below to continue" },
    { url: "https://www.google.com/sorry/index", title: "", text: "" },
    { url: "https://shop.example/", title: "", text: "I'm not a robot" },
    { url: "", title: "", text: "" },
  ];
  const pool = [
    ...PROVIDER_URLS,
    ...ORDINARY_FRAME_URLS,
    ...CHALLENGE_LIKE_URLS,
    "https://cdn.partner.example/w/9f3.html",
    "https://shop.example/cart-widget",
  ];
  let seed = 0x9e3779b9;
  const next = (bound) => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed % bound;
  };
  // The limitation, stated concretely first so the randomized half below is
  // measuring a real escape hatch and not an empty one: more opaque
  // cross-origin frames than the budget, none of their URLs saying anything,
  // one of them holding the challenge.
  const opaque = Array.from({ length: CHALLENGE_UNREAD_FRAME_BUDGET + 2 }, (_, index) => ({
    url: `https://cdn.partner.example/w/${index}.html`,
    text: index === 2 ? "Verify you are human" : "Sponsored content",
    visible: true,
    readable: false,
  }));
  assert.equal(
    challengeScanNeeded({
      openProviders: new Set(),
      blockedAt: 0,
      now: 1_700_000_000_000,
      main: BENIGN_MAIN,
      frames: urlFrames(opaque.map((frame) => frame.url)),
      solvedProviders: [],
    }),
    false,
  );
  assert.equal(
    detectBotChallenge({ main: BENIGN_MAIN, frames: opaque })?.detectedIn,
    "frame",
  );

  for (let round = 0; round < 4_000; round += 1) {
    const main = mains[next(mains.length)];
    // What the full scan would have produced: every frame, text and all.
    const scanned = Array.from({ length: next(8) }, () => ({
      url: pool[next(pool.length)],
      text: next(3) === 0 ? "I'm not a robot" : "Sponsored content",
      visible: next(4) !== 0,
      readable: next(2) === 0,
    }));
    // What the gate actually gets: an unread frame contributes its URL only.
    const offered = scanned.map((frame) =>
      frame.readable
        ? frame
        : { url: frame.url, visible: frame.visible, readable: false },
    );
    const solvedProviders = next(4) === 0 ? ["recaptcha", "turnstile", "hcaptcha"] : [];
    const state = { openProviders: new Set(), blockedAt: 0, now: 1_700_000_000_000, main, frames: offered, solvedProviders };
    if (challengeScanNeeded(state)) continue;
    const reported = detectBotChallenge({ main, frames: scanned, solvedProviders });
    if (!reported) continue;
    const where = JSON.stringify({ main, scanned, solvedProviders });
    assert.equal(reported.detectedIn, "frame", `gate skipped a main-frame challenge: ${where}`);
    assert.equal(
      detectBotChallenge({
        main,
        frames: scanned.filter((frame) => frame.readable),
        solvedProviders,
      }),
      null,
      `gate skipped a challenge it had already been shown: ${where}`,
    );
    assert.ok(
      scanned.filter((frame) => !frame.readable && frame.visible !== false).length >
        CHALLENGE_UNREAD_FRAME_BUDGET,
      `gate skipped an unread frame it had budget to read: ${where}`,
    );
  }
});

// The gate's own inputs, judged against what the post-gate detector sees. This
// is the weaker but unconditional half: a skipped scan reports no frames at
// all, so the envelope must be empty whenever the gate says no.
test("skipping the scan never hides a challenge the envelope would have reported", () => {
  const mains = [
    BENIGN_MAIN,
    { url: "https://shop.example/", title: "Just a moment...", text: "Checking your browser before accessing shop.example." },
    { url: "https://www.bing.com/search?q=a", title: "One last step", text: "Please solve the challenge below to continue" },
    { url: "https://www.google.com/sorry/index", title: "", text: "" },
    { url: "https://shop.example/", title: "", text: "I'm not a robot" },
    { url: "", title: "", text: "" },
  ];
  const pool = [...PROVIDER_URLS, ...BENIGN_URLS];
  // Deterministic pseudo-random frame sets: a fixed seed keeps a failure
  // reproducible from the assertion message alone.
  let seed = 0x9e3779b9;
  const next = (bound) => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed % bound;
  };
  for (let round = 0; round < 2_000; round += 1) {
    const main = mains[next(mains.length)];
    const frames = Array.from({ length: next(6) }, () => ({
      url: pool[next(pool.length)],
      text: next(3) === 0 ? "I'm not a robot" : "Sponsored content",
      visible: next(4) !== 0,
    }));
    const solvedProviders = next(4) === 0 ? ["recaptcha", "turnstile", "hcaptcha"] : [];
    const state = { openProviders: new Set(), blockedAt: 0, now: 1_700_000_000_000, main, frames, solvedProviders };
    if (challengeScanNeeded(state)) continue;
    const reported = detectBotChallenge({ main, frames: [], solvedProviders });
    assert.equal(
      reported,
      null,
      `gate skipped the scan but the envelope would still report ${JSON.stringify({ main, frames, solvedProviders })}`,
    );
  }
});

// The gate's own state is the one way it can wedge: if `openProviders` were
// ever written by a skipped scan, a page that solved its challenge would keep
// paying for the full frame walk forever. This walks the loop worker.ts runs.
test("open-provider state drains once the challenge clears", () => {
  const step = (openProviders, page) => {
    const scanned = challengeScanNeeded({
      openProviders,
      blockedAt: 0,
      now: 1_700_000_000_000,
      main: page.main,
      frames: page.frames.map((frame) => ({ url: frame.url })),
      solvedProviders: page.solvedProviders,
    });
    // Stage 2 is what supplies frame text and visibility; a skipped scan
    // reports no frames at all.
    const challenge = detectBotChallenge({
      main: page.main,
      frames: scanned ? page.frames : [],
      solvedProviders: page.solvedProviders,
    });
    const next = new Set(challenge ? [challenge.provider] : []);
    return { scanned, provider: challenge?.provider ?? null, next };
  };

  const challenged = {
    main: BENIGN_MAIN,
    frames: [
      {
        url: "https://www.google.com/recaptcha/api2/bframe?k=site-key",
        text: "Select all images with traffic lights",
        visible: true,
      },
    ],
    solvedProviders: [],
  };
  const first = step(new Set(), challenged);
  assert.equal(first.scanned, true);
  assert.equal(first.provider, "recaptcha");

  // Still unsolved: the open set keeps forcing the scan.
  const second = step(first.next, challenged);
  assert.equal(second.scanned, true);
  assert.equal(second.provider, "recaptcha");

  // Token filled. The scan still runs (the set is non-empty), finds nothing,
  // and writes the empty set back.
  const solved = { ...challenged, solvedProviders: ["recaptcha"] };
  const third = step(second.next, solved);
  assert.equal(third.scanned, true);
  assert.equal(third.provider, null);
  assert.equal(third.next.size, 0);

  // Navigated away instead: same drain, no token needed.
  const cleared = { main: BENIGN_MAIN, frames: [], solvedProviders: [] };
  const fourth = step(second.next, cleared);
  assert.equal(fourth.scanned, true);
  assert.equal(fourth.next.size, 0);
  assert.equal(step(fourth.next, cleared).scanned, false);
});
