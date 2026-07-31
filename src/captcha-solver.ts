// Local, self-hosted CAPTCHA solving for BetterWright.
//
// Solves challenges inside the existing browser session with human-shaped
// pointer motion. No third-party captcha APIs, no token farms, no heavy ML
// runtimes — just DOM/frame inspection, clicks, drags, waits, and vision
// handoff when an image or text stage needs the host model.
//
// Result envelope mirrors the 2Captcha mental model (create → poll status)
// while remaining fully in-process:
//   status "ready"       → challenge cleared (token present or widget gone)
//   status "processing"  → needs another stage or vision handoff
//   status "error"       → rejected, timed out, or unsupported

import {
  hostIs,
  isGoogleHost,
  isRecord,
  normalizedText,
  parsedUrl,
  stringValue,
} from "./untrusted-value.js";

export const CAPTCHA_SOLVE_STATUSES = Object.freeze({
  READY: "ready",
  PROCESSING: "processing",
  ERROR: "error",
});

export const CAPTCHA_STAGES = Object.freeze({
  NONE: "none",
  CHECKBOX: "checkbox",
  TURNSTILE: "turnstile",
  MANAGED: "managed_challenge",
  IMAGE_GRID: "image_grid",
  SLIDER: "slider",
  TEXT: "text",
  INVISIBLE: "invisible",
  UNKNOWN: "unknown",
});

export const CAPTCHA_PROVIDERS = Object.freeze([
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "cloudflare",
  "bing",
  "google",
  "generic",
]);

const IMAGE_GRID_TEXT =
  /(?:please )?(?:click|select|choose|tap) (?:all|each|every|the) (?:image|images|square|squares|tile|tiles)\b|select all images|which of these|pick each image|contains a \w+/i;

const SLIDER_TEXT =
  /(?:slide|drag|swipe|move).{0,40}(?:slider|puzzle|piece|handle|arrow)|complete the (?:puzzle|slider)/i;

const TEXT_CAPTCHA_TEXT =
  /(?:type|enter|fill).{0,30}(?:characters|code|text|letters|numbers)|what (?:code|text|characters)/i;

const CHECKBOX_TEXT =
  /i(?:'|’)?m not a robot|verify you are human|confirm you are (?:a )?human|i am human/i;

const MANAGED_TEXT =
  /checking your browser|just a moment|performing security verification|enable javascript and cookies|ddos protection by cloudflare|attention required/i;

function providerFromUrl(url) {
  const parsed = parsedUrl(url);
  const host = parsed?.hostname.toLowerCase() || "";
  if (!host) return "generic";
  if (hostIs(host, "hcaptcha.com")) return "hcaptcha";
  if (hostIs(host, "cloudflare.com")) {
    return parsed.pathname.toLowerCase().includes("turnstile") ? "turnstile" : "cloudflare";
  }
  if (isGoogleHost(host) || hostIs(host, "recaptcha.net")) {
    if (parsed.pathname.toLowerCase().includes("/recaptcha/")) return "recaptcha";
    return "google";
  }
  if (hostIs(host, "bing.com")) return "bing";
  return "generic";
}

/**
 * Classify the interactive stage of a detected challenge from metadata.
 * Pure function — safe for unit tests without a browser.
 */
export function classifyChallengeStage(metadata: any = {}) {
  const input = isRecord(metadata) ? metadata : {};
  const main = isRecord(input.main) ? input.main : input;
  const frames = Array.isArray(input.frames)
    ? input.frames.filter(isRecord)
    : Array.isArray(input.childFrames)
      ? input.childFrames.filter(isRecord)
      : [];
  // Prefer child frames first so host-page marketing copy (e.g. a solver demo
  // site listing slider/image captchas) cannot override a live provider widget.
  const sources = [
    ...frames.map((frame, index) => ({
      kind: "frame",
      index,
      url: stringValue(frame.url),
      title: stringValue(frame.title),
      text: stringValue(frame.text),
      visible: typeof frame.visible === "boolean" ? frame.visible : null,
    })),
    {
      kind: "main",
      // The main document has no frame index; null keeps this shape union-
      // compatible with the frame entries above so callers can read `.index`
      // off either without narrowing.
      index: null,
      url: stringValue(main.url ?? input.url),
      title: stringValue(main.title ?? input.title),
      text: stringValue(main.text ?? input.text),
      visible: true,
    },
  ];

  let provider = stringValue(input.provider) || "generic";
  let stage: string = CAPTCHA_STAGES.NONE;
  let signal = null;
  let source = sources[sources.length - 1];

  for (const candidate of sources) {
    // Sites preload dormant CAPTCHA providers in hidden iframes. They are not
    // an interactive stage until the frame becomes visible or the host page
    // presents an explicit blocking prompt.
    if (candidate.kind === "frame" && candidate.visible === false) continue;
    const text = normalizedText(`${candidate.title}\n${candidate.text}`);
    const url = candidate.url.toLowerCase();
    const parsed = parsedUrl(candidate.url);
    const path = parsed?.pathname.toLowerCase() || "";
    const fromUrl = providerFromUrl(candidate.url);
    if (fromUrl !== "generic") provider = fromUrl;

    // Image grid / bframe challenge UI takes priority over every other stage.
    if (
      IMAGE_GRID_TEXT.test(text) ||
      path.includes("/bframe") ||
      /[?&#]frame=challenge(?:[&#]|$)/.test(url) ||
      /\/hcaptcha-?challenge/.test(path)
    ) {
      stage = CAPTCHA_STAGES.IMAGE_GRID;
      signal = "image_grid";
      source = candidate;
      break;
    }

    if (
      path.includes("/cdn-cgi/challenge-platform/") &&
      !path.includes("/turnstile/")
    ) {
      stage = CAPTCHA_STAGES.MANAGED;
      signal = "cloudflare_managed";
      source = candidate;
      if (provider === "generic") provider = "cloudflare";
      // Keep scanning frames for an image-grid escalation; do not let main copy win.
      if (candidate.kind === "frame") continue;
      break;
    }

    if (MANAGED_TEXT.test(text) && stage === CAPTCHA_STAGES.NONE) {
      stage = CAPTCHA_STAGES.MANAGED;
      signal = "managed_text";
      source = candidate;
      if (fromUrl === "cloudflare" || fromUrl === "turnstile") provider = fromUrl;
      if (candidate.kind === "frame") continue;
      break;
    }

    if (
      path.includes("/turnstile/") ||
      hostIs(parsedUrl(candidate.url)?.hostname.toLowerCase() || "", "challenges.cloudflare.com")
    ) {
      if (
        stage === CAPTCHA_STAGES.NONE ||
        stage === CAPTCHA_STAGES.CHECKBOX ||
        stage === CAPTCHA_STAGES.UNKNOWN ||
        stage === CAPTCHA_STAGES.INVISIBLE
      ) {
        stage = CAPTCHA_STAGES.TURNSTILE;
        signal = "turnstile_widget";
        source = candidate;
        provider = "turnstile";
      }
      // Keep scanning frames for image-grid escalation only.
      continue;
    }

    // Slider / text only apply when no stronger provider stage is already known.
    // Host-page marketing ("we support slider captchas…") must not override widgets.
    if (
      (stage === CAPTCHA_STAGES.NONE || stage === CAPTCHA_STAGES.UNKNOWN) &&
      (SLIDER_TEXT.test(text) || /slider|puzzle-captcha|geetest/i.test(text))
    ) {
      stage = CAPTCHA_STAGES.SLIDER;
      signal = "slider";
      source = candidate;
      if (candidate.kind === "frame") break;
      continue;
    }

    if (
      stage === CAPTCHA_STAGES.NONE &&
      TEXT_CAPTCHA_TEXT.test(text) &&
      /captcha|challenge|security/i.test(text)
    ) {
      stage = CAPTCHA_STAGES.TEXT;
      signal = "text_challenge";
      source = candidate;
      if (candidate.kind === "frame") break;
      continue;
    }

    if (
      path.endsWith("/anchor") ||
      /[?&#]frame=checkbox(?:[&#]|$)/.test(url) ||
      CHECKBOX_TEXT.test(text)
    ) {
      if (stage === CAPTCHA_STAGES.NONE || stage === CAPTCHA_STAGES.UNKNOWN) {
        stage = CAPTCHA_STAGES.CHECKBOX;
        signal = "checkbox";
        source = candidate;
      }
      continue;
    }

    if (/(?:^|[?&#])size=invisible(?:[&#]|$)/.test(url) || url.includes("checkbox-invisible")) {
      if (stage === CAPTCHA_STAGES.NONE) {
        stage = CAPTCHA_STAGES.INVISIBLE;
        signal = "invisible_widget";
        source = candidate;
      }
    }
  }

  if (stage === CAPTCHA_STAGES.NONE && (input.provider || input.type === "bot_challenge")) {
    stage = CAPTCHA_STAGES.UNKNOWN;
    signal = "unclassified";
  }

  return {
    stage,
    provider,
    signal,
    source: {
      kind: source?.kind || "main",
      url: source?.url || "",
      index: source?.index ?? null,
    },
    autoSolvable:
      stage === CAPTCHA_STAGES.CHECKBOX ||
      stage === CAPTCHA_STAGES.TURNSTILE ||
      stage === CAPTCHA_STAGES.MANAGED ||
      stage === CAPTCHA_STAGES.SLIDER,
    needsVision:
      stage === CAPTCHA_STAGES.IMAGE_GRID || stage === CAPTCHA_STAGES.TEXT,
  };
}

/** Frame URL patterns used to locate provider widgets in the live page. */
export const WIDGET_FRAME_PATTERNS = Object.freeze({
  recaptcha: /recaptcha(?:\.net|\/)|google\.com\/recaptcha/i,
  hcaptcha: /hcaptcha\.com/i,
  turnstile: /challenges\.cloudflare\.com|turnstile/i,
  cloudflare: /cdn-cgi\/challenge-platform/i,
});

/**
 * Selectors for checkbox / verify controls inside provider frames or main page.
 * Ordered from most specific to fallbacks.
 */
export const CHECKBOX_SELECTORS = Object.freeze([
  "#checkbox",
  ".recaptcha-checkbox-border",
  ".recaptcha-checkbox",
  "#recaptcha-anchor",
  "[role='checkbox']",
  "input[type='checkbox']",
  ".mark",
  "#cf-stage",
  "label.cb-lb",
  ".cb-lb",
  "input[type='checkbox'] + span",
  "body",
]);

export const VERIFY_BUTTON_SELECTORS = Object.freeze([
  "#recaptcha-verify-button",
  ".button-submit",
  "button[type='submit']",
  "input[type='submit']",
  "[data-callback]",
  "button:has-text('Verify')",
  "button:has-text('Submit')",
  "button:has-text('Continue')",
  "button:has-text('I am human')",
  "input[value*='Verify' i]",
]);

export const SLIDER_SELECTORS = Object.freeze([
  "[role='slider']",
  ".slider-handle",
  ".slide-button",
  ".geetest_slider_button",
  ".captcha-slider-button",
  ".slider",
  ".handle-handle",
  ".dragger",
  "#slider",
]);

export const IMAGE_TILE_SELECTORS = Object.freeze([
  "td.rc-imageselect-tile",
  ".rc-imageselect-tile",
  ".task-image",
  ".image-wrapper",
  "[role='button'][aria-label]",
  ".challenge-image",
  "div[class*='tile']",
  "div[class*='image'] button",
]);

/**
 * Build a 2Captcha-style solve result envelope.
 */
export function buildSolveResult({
  status,
  provider = "generic",
  stage = CAPTCHA_STAGES.UNKNOWN,
  requestId = null,
  token = null,
  errorCode = null,
  errorText = null,
  attempts = [],
  artifact = null,
  tiles = null,
  instruction = null,
  cleared = false,
  challenge = null,
}: any = {}): any {
  const id =
    requestId ||
    `bw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    // 2Captcha-compatible field names where they map cleanly.
    status,
    request: id,
    requestId: id,
    // BetterWright extensions.
    provider,
    stage,
    cleared: Boolean(cleared || status === CAPTCHA_SOLVE_STATUSES.READY),
    token: token || null,
    errorCode: errorCode || null,
    errorText: errorText || null,
    attempts: Array.isArray(attempts) ? attempts : [],
    artifact: artifact || null,
    tiles: tiles || null,
    instruction: instruction || null,
    challenge: challenge || null,
    local: true,
    externalApi: false,
  };
}

/**
 * Decide the next auto-solve action from a classified stage.
 * Pure strategy table — the worker executes the returned action.
 */
export function nextSolveAction(classification, attemptIndex = 0) {
  const stage = classification?.stage || CAPTCHA_STAGES.UNKNOWN;
  switch (stage) {
    case CAPTCHA_STAGES.CHECKBOX:
      return {
        action: "click_checkbox",
        waitMs: 2_500,
        description: "Click the provider checkbox with human-shaped motion",
      };
    case CAPTCHA_STAGES.TURNSTILE:
      return {
        action: attemptIndex === 0 ? "click_checkbox" : "wait_token",
        waitMs: attemptIndex === 0 ? 3_000 : 5_000,
        description:
          attemptIndex === 0
            ? "Click the Turnstile widget"
            : "Wait for Turnstile to issue a response token",
      };
    case CAPTCHA_STAGES.MANAGED:
      return {
        action: attemptIndex === 0 ? "click_verify" : "wait_clear",
        waitMs: 5_000,
        description:
          attemptIndex === 0
            ? "Click the managed-challenge verify control if present"
            : "Wait for the managed browser check to clear",
      };
    case CAPTCHA_STAGES.SLIDER:
      return {
        action: "drag_slider",
        waitMs: 2_000,
        description: "Drag the slider/puzzle handle",
      };
    case CAPTCHA_STAGES.IMAGE_GRID:
      return {
        action: "capture_tiles",
        waitMs: 0,
        description:
          "Capture the image grid and tile bounds for host vision; no auto-click without vision",
      };
    case CAPTCHA_STAGES.TEXT:
      return {
        action: "capture_text",
        waitMs: 0,
        description: "Capture the text CAPTCHA crop for host vision/OCR",
      };
    case CAPTCHA_STAGES.INVISIBLE:
      return {
        action: "wait_token",
        waitMs: 4_000,
        description: "Wait for the invisible widget to mint a token",
      };
    default:
      return {
        action: "inspect",
        waitMs: 0,
        description: "Inspect the challenge visually; no automatic action available",
      };
  }
}

export function maxAutoStages(options: any = {}) {
  const raw = Number(options?.maxStages ?? options?.maxAttempts ?? 3);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(5, Math.floor(raw)));
}

export function solveTimeoutMs(options: any = {}) {
  const raw = Number(options?.timeout ?? options?.timeoutMs ?? 45_000);
  if (!Number.isFinite(raw)) return 45_000;
  return Math.max(3_000, Math.min(180_000, Math.floor(raw)));
}
