import {
  hostIs,
  isBoolean,
  isGoogleHost,
  isNumber,
  isRecord,
  normalizedText,
  parsedUrl,
  stringValue,
  untrustedField,
} from "./untrusted-value.js";

const NATIVE_CAPTCHA_HELPERS = Object.freeze([
  "captcha.solve",
  "captcha.detect",
  "captcha.inspect",
  "captcha.click",
  "captcha.drag",
  "captcha.readText",
  "captcha.clickTiles",
  "human.click",
]);

const PUBLIC_SEARCH_BLOCK_ADVICE =
  "Public search-result UI automation is disabled for this managed browser. " +
  "Use the host web-search/research tool for discovery, then open the selected " +
  "first-party result page in BetterWright.";

const SEARCH_CHALLENGE_ADVICE =
  "A bot challenge is blocking this page. Preserve this page and solve it before " +
  "retrying the blocked action. Prefer `captcha.solve()` for local automatic " +
  "checkbox, Turnstile, managed-challenge, and slider stages (no external APIs). " +
  "If solve returns status `processing` with a vision artifact (image grid or " +
  "text), open the attached numbered crop, pick matching tile indexes, then " +
  "call `captcha.solve({ tiles: [indexes] })`. Fall back to `captcha.inspect`, `captcha.click`, " +
  "`captcha.drag`, `captcha.readText`, `captcha.clickTiles`, or `human.click` when needed. Continue " +
  "through up to three distinct stages of the same challenge. As soon as it " +
  "clears, resume the original action and continue the task. Never repeat the " +
  "same failed action or rotate identities/search engines; after three unresolved " +
  "stages, use a host web-research tool, first-party route, or human handoff.";

function normalizeSource(value, kind, index = null, fallback: any = {}) {
  const source = isRecord(value) ? value : {};
  const visible = untrustedField(source, "visible");
  return {
    kind,
    index,
    url: stringValue(untrustedField(source, "url") ?? fallback.url),
    title: stringValue(untrustedField(source, "title") ?? fallback.title),
    text: stringValue(untrustedField(source, "text") ?? fallback.text),
    completed: untrustedField(source, "completed") === true,
    visible: isBoolean(visible) ? visible : null,
  };
}

function normalizeMetadata(metadata) {
  const input = isRecord(metadata) ? metadata : {};
  const nestedMain = [
    untrustedField(input, "main"),
    untrustedField(input, "mainPage"),
    untrustedField(input, "page"),
  ].find(isRecord);
  const main = normalizeSource(nestedMain || input, "main", null, input);
  const frameValues =
    [untrustedField(input, "frames"), untrustedField(input, "childFrames")].find(
      Array.isArray,
    ) || [];
  const frames = frameValues
    .filter(isRecord)
    .map((frame, index) => normalizeSource(frame, "frame", index));
  const solved = untrustedField(input, "solvedProviders");
  const solvedProviders = new Set(
    (Array.isArray(solved) ? solved : [])
      .map((provider) => normalizedText(provider))
      .filter(Boolean),
  );
  return { main, frames, solvedProviders };
}

function providerForPage(url) {
  const parsed = parsedUrl(url);
  const host = parsed?.hostname.toLowerCase() || "";
  if (isGoogleHost(host)) return "google";
  if (hostIs(host, "bing.com")) return "bing";
  if (hostIs(host, "duckduckgo.com")) return "duckduckgo";
  if (hostIs(host, "cloudflare.com")) return "cloudflare";
  if (hostIs(host, "hcaptcha.com")) return "hcaptcha";
  return host || "unknown";
}

// Provider host/path shapes shared by the full detector (challengeUrlSignal)
// and the cheap URL-only gate (frameUrlLooksLikeChallenge). Both must read the
// same constants: a gate that misses a URL the detector would match turns into
// a silent false negative once the frame scan is staged behind it.
const GOOGLE_SORRY_PATH = /^\/sorry(?:\/|$)/;
const BING_CHALLENGE_PATH = /\/(?:captcha|challenge|turing)(?:\/|$)/;
const RECAPTCHA_FRAME_PATH = /\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)(?:\/|$)/;
const HCAPTCHA_CHALLENGE_QUERY = /(?:^|[?&#])frame=challenge(?:[&#]|$)/;
const HCAPTCHA_CHALLENGE_PATH = /(?:^|\/)(?:hcaptcha-)?challenge(?:\.html)?(?:\/|$)/;
const HCAPTCHA_IMAGE_PROMPT =
  /(?:please )?(?:click|select|choose) (?:all|each|every|the) (?:image|images|square|squares)\b/;
const CLOUDFLARE_PLATFORM_PATH = "/cdn-cgi/challenge-platform/";
const TURNSTILE_PATH = "/turnstile/";

function isRecaptchaHost(host) {
  return isGoogleHost(host) || hostIs(host, "recaptcha.net");
}

function explicitInvisible(url) {
  let decoded = stringValue(url).toLowerCase();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // The undecoded URL is still useful for the common cases.
  }
  return /(?:^|[?&#])size=invisible(?:[&#]|$)/.test(decoded) ||
    decoded.includes("checkbox-invisible");
}

function challengeUrlSignal(source, includeInvisible = false) {
  // Provider widgets are commonly preloaded in zero-size/hidden iframes long
  // before a site asks the user to verify anything. Treating their URL alone
  // as an active challenge derails normal forms and makes agents attempt a
  // CAPTCHA that has not been issued. Visible prompt text can still identify
  // a real escalation through genericTextSignal below.
  if (!includeInvisible && source.kind === "frame" && source.visible === false) {
    return null;
  }
  const parsed = parsedUrl(source.url);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const whole = `${path}${parsed.search}${parsed.hash}`.toLowerCase();

  if (isGoogleHost(host) && GOOGLE_SORRY_PATH.test(path)) {
    return { provider: "google", signal: "google_sorry_url", source };
  }
  if (hostIs(host, "bing.com") && BING_CHALLENGE_PATH.test(path)) {
    return { provider: "bing", signal: "bing_challenge_url", source };
  }

  const recaptchaHost = isRecaptchaHost(host);
  const recaptchaFrame = RECAPTCHA_FRAME_PATH.test(path);
  if (recaptchaHost && recaptchaFrame) {
    if (!includeInvisible && path.endsWith("/anchor") && explicitInvisible(source.url)) return null;
    return { provider: "recaptcha", signal: "recaptcha_frame_url", source };
  }

  const hcaptchaFrameText = normalizedText(`${source.title}\n${source.text}`);
  const hcaptchaChallengeFrame =
    hostIs(host, "hcaptcha.com") &&
    (HCAPTCHA_CHALLENGE_QUERY.test(whole) ||
      HCAPTCHA_CHALLENGE_PATH.test(path) ||
      (path.includes("/captcha/") && HCAPTCHA_IMAGE_PROMPT.test(hcaptchaFrameText)));
  if (hcaptchaChallengeFrame) {
    return { provider: "hcaptcha", signal: "hcaptcha_frame_url", source };
  }

  const cloudflarePlatform = path.includes(CLOUDFLARE_PLATFORM_PATH);
  const turnstileFrame =
    hostIs(host, "challenges.cloudflare.com") &&
    (cloudflarePlatform || path.includes(TURNSTILE_PATH));
  if (turnstileFrame) {
    if (!includeInvisible && explicitInvisible(source.url)) return null;
    return { provider: "turnstile", signal: "turnstile_frame_url", source };
  }
  if (cloudflarePlatform) {
    return { provider: "cloudflare", signal: "cloudflare_challenge_url", source };
  }
  return null;
}

function searchProviderTextSignal(main) {
  const parsed = parsedUrl(main.url);
  const host = parsed?.hostname.toLowerCase() || "";
  const text = normalizedText(`${main.title}\n${main.text}`);

  if (
    isGoogleHost(host) &&
    (text.includes("our systems have detected unusual traffic") ||
      text.includes("your computer or network may be sending automated queries"))
  ) {
    return { provider: "google", signal: "google_unusual_traffic_text", source: main };
  }

  const bingSolvePrompt =
    text.includes("please solve the challenge below to continue") ||
    /(?:verify|confirm) (?:that )?you(?: are|'re) (?:a )?human/.test(text);
  if (hostIs(host, "bing.com") && text.includes("one last step") && bingSolvePrompt) {
    return { provider: "bing", signal: "bing_challenge_text", source: main };
  }
  return null;
}

function genericTextSignal(source) {
  if (source.kind === "frame" && source.visible === false) return null;
  const title = normalizedText(source.title);
  const body = normalizedText(source.text);
  const text = `${title} ${body}`.trim();
  if (!text) return null;

  const humanPromptPattern =
    /^(?:please )?(?:verify|confirm|prove)(?: that)? you(?: are|'re) (?:a )?human[.!]?$/;
  const shortHumanPrompt = body.length <= 240 && humanPromptPattern.test(body);
  const humanHeading = title.length <= 120 && humanPromptPattern.test(title);
  const blockingHumanPrompt =
    /(?:please )?(?:verify|confirm|prove)(?: that)? you(?: are|'re) (?:a )?human (?:to|before you) (?:continue|proceed|access|submit|search)/.test(
      text,
    );
  const explicitChallenge = [
    "please solve the challenge below to continue",
    "complete the security check to continue",
    "complete the captcha to continue",
    "checking your browser before accessing",
    "performing security verification",
  ].some((marker) => text.includes(marker));
  const robotPrompt =
    body.length <= 160 &&
    /^(?:i am|i'm) not a robot[.!]?(?: privacy terms)?$/.test(body);
  const holdPrompt =
    text.includes("press and hold") && /(?:human|robot|security check|verify)/.test(text);

  if (
    !shortHumanPrompt &&
    !humanHeading &&
    !blockingHumanPrompt &&
    !explicitChallenge &&
    !robotPrompt &&
    !holdPrompt
  ) {
    return null;
  }

  let provider = challengeUrlSignal(source, true)?.provider || providerForPage(source.url);
  if (/\bhcaptcha\b/.test(text)) provider = "hcaptcha";
  else if (/\brecaptcha\b/.test(text) || text.includes("i'm not a robot"))
    provider = "recaptcha";
  else if (/\bturnstile\b|\bcloudflare\b/.test(text)) provider = "turnstile";
  return { provider, signal: "verify_human_text", source };
}

function challengeResult(main, match) {
  return {
    type: "bot_challenge",
    provider: match.provider,
    url: main.url,
    challengeUrl: match.source.url || main.url,
    detectedIn: match.source.kind,
    signal: match.signal,
    solve: {
      maxAttempts: 3,
      resumeOnClear: true,
      helpers: NATIVE_CAPTCHA_HELPERS,
    },
    advice: SEARCH_CHALLENGE_ADVICE,
  };
}

/**
 * URL-only "this frame might be a challenge" test, built from the same provider
 * host/path constants as `challengeUrlSignal`. It is deliberately broader than
 * the detector — it cannot see frame text, visibility, or `size=invisible`, so
 * it must never narrow past what a later full scan could match. Callers use it
 * to decide whether the expensive per-frame scan is worth running at all.
 */
export function frameUrlLooksLikeChallenge(url) {
  const parsed = parsedUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (path.includes(CLOUDFLARE_PLATFORM_PATH)) return true;
  if (hostIs(host, "challenges.cloudflare.com")) return true;
  if (hostIs(host, "hcaptcha.com")) return true;
  if (isGoogleHost(host) && GOOGLE_SORRY_PATH.test(path)) return true;
  if (hostIs(host, "bing.com") && BING_CHALLENGE_PATH.test(path)) return true;
  return isRecaptchaHost(host) && RECAPTCHA_FRAME_PATH.test(path);
}

// Gate-only shapes, deliberately outside `challengeUrlSignal`. The detector
// names a provider from these frames only after reading their *text* (they end
// up as `providerForPage`'s host fallback in genericTextSignal), so the URL
// alone must never report a challenge — but it is exactly what the gate has to
// judge, because these frames are cross-origin and their text costs a round
// trip. Commercial vendors whose challenge frame URL names no provider the
// detector knows:
const VENDOR_CHALLENGE_HOSTS = [
  "captcha-delivery.com", // DataDome
  "datadome.co",
  "arkoselabs.com", // Arkose Labs / FunCaptcha
  "funcaptcha.com",
  "awswaf.com", // AWS WAF Captcha
  "px-cdn.net", // PerimeterX / HUMAN
  "perimeterx.net",
  "geetest.com",
];
// …plus any host or path that says "captcha" in the usual words, which is what
// self-hosted challenge endpoints are almost always called. Separator-anchored
// so `recaptcha.example.com` and `challenges.cloudflare.com.evil.test` — the
// lookalikes `frameUrlLooksLikeChallenge` must reject — do not match a bare
// substring.
const CHALLENGE_URL_TOKEN =
  /(?:^|[.\-/_])(?:captcha|challenge|turing|verify|human|bot[-_]?check)(?:[.\-/_]|$)/;

/**
 * Whether an unread frame's URL is challenge-shaped enough to be worth reading.
 * Not a detection: it only decides whether the frame's text gets fetched at all.
 */
function frameUrlSuggestsChallenge(url) {
  if (frameUrlLooksLikeChallenge(url)) return true;
  const parsed = parsedUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (VENDOR_CHALLENGE_HOSTS.some((vendor) => hostIs(host, vendor))) return true;
  return CHALLENGE_URL_TOKEN.test(`${host}${parsed.pathname.toLowerCase()}`);
}

export function isPublicSearchNavigation(url) {
  const parsed = parsedUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (isGoogleHost(host)) return path === "/search";
  if (hostIs(host, "bing.com")) {
    return ["/search", "/images/search", "/videos/search", "/news/search"].includes(
      path,
    );
  }
  return (
    hostIs(host, "duckduckgo.com") &&
    ["/", "/html", "/lite"].includes(path)
  );
}

/** Detect a visible CAPTCHA/bot challenge from serializable page and frame metadata. */
export function detectBotChallenge(metadata: any = {}) {
  const { main, frames, solvedProviders } = normalizeMetadata(metadata);
  const firstMatch = (sources, signalFor) => {
    for (const source of sources) {
      const match = signalFor(source);
      if (match && !source.completed && !solvedProviders.has(match.provider)) {
        return match;
      }
    }
    return null;
  };

  const sources = [main, ...frames];
  const match =
    firstMatch([main], searchProviderTextSignal) ||
    firstMatch(sources, challengeUrlSignal) ||
    firstMatch(sources, genericTextSignal);
  return match ? challengeResult(main, match) : null;
}

/**
 * How long after a 403/429/503 main-document response the next scan still
 * treats the page as possibly serving an interstitial.
 */
export const CHALLENGE_BLOCK_WINDOW_MS = 10_000;

/**
 * How many frames whose text the caller could not read the gate will pay to
 * read anyway. Text is the only thing that identifies a challenge in a
 * cross-origin frame whose URL names no provider, so up to this many unread
 * frames force the scan unconditionally — the scan then costs less than the
 * round trips the gate saves elsewhere. Past the budget only
 * `frameUrlSuggestsChallenge` speaks for an unread frame, which is the one
 * accepted narrowing in this design (see docs/captcha.md).
 */
export const CHALLENGE_UNREAD_FRAME_BUDGET = 3;

/**
 * Decide whether the caller should pay for a full per-frame challenge scan.
 *
 * Reading a frame costs a round trip each, so the scan runs only once something
 * already points at a challenge. Every condition covers a way a challenge can
 * exist that the others would miss, ordered cheapest first:
 *
 *   - `openProviders` — a challenge was still open after the previous scan.
 *     Only a completed full scan may rewrite that set, so this both keeps
 *     watching an unsolved challenge and guarantees the set drains once the
 *     page clears.
 *   - `blockedAt` — the site just answered a document with a block status, and
 *     the interstitial it swapped in may not have rendered recognizable text
 *     yet.
 *   - a main or frame URL that `frameUrlLooksLikeChallenge` recognizes.
 *   - `detectBotChallenge` over the main frame plus whatever `frames` carry.
 *     Callers pass every frame the full scan would read, with as much of its
 *     text and visibility as they already have; adding fields to a source can
 *     only widen a match, never narrow it, so a "no" here is at least as
 *     complete as the answer the reported metadata would have produced.
 *   - frames the caller could not read at all (`readable !== true`). Their text
 *     is exactly what the previous condition is missing, so they are judged on
 *     URL shape and, up to `CHALLENGE_UNREAD_FRAME_BUDGET` of them, read
 *     regardless. A frame the caller knows to be invisible is exempt: both
 *     `challengeUrlSignal` and `genericTextSignal` drop `visible === false`
 *     frames, so reading one could not change the reported metadata.
 *
 * Pure: the caller supplies `now` and the already-read frames, so the decision
 * is reproducible from its inputs alone.
 */
export function challengeScanNeeded(state: any = {}) {
  const input: any = isRecord(state) ? state : {};
  const openProviders = input.openProviders;
  const openCount = openProviders
    ? (openProviders.size ?? openProviders.length ?? 0)
    : 0;
  if (openCount > 0) return true;

  const blockedAt = isNumber(input.blockedAt) ? input.blockedAt : 0;
  const now = isNumber(input.now) ? input.now : Date.now();
  if (blockedAt > 0 && now - blockedAt <= CHALLENGE_BLOCK_WINDOW_MS) return true;

  const main = isRecord(input.main) ? input.main : {};
  const frames = (Array.isArray(input.frames) ? input.frames : []).filter(isRecord);
  if (frameUrlLooksLikeChallenge(main.url)) return true;
  if (frames.some((frame: any) => frameUrlLooksLikeChallenge(frame.url))) return true;

  const unread = frames.filter(
    (frame: any) => frame.readable !== true && frame.visible !== false,
  );
  if (unread.length > 0 && unread.length <= CHALLENGE_UNREAD_FRAME_BUDGET) return true;
  if (unread.some((frame: any) => frameUrlSuggestsChallenge(frame.url))) return true;

  return Boolean(
    detectBotChallenge({ main, frames, solvedProviders: input.solvedProviders }),
  );
}

export { PUBLIC_SEARCH_BLOCK_ADVICE, SEARCH_CHALLENGE_ADVICE };
