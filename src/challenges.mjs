const NATIVE_CAPTCHA_HELPERS = Object.freeze([
  "captcha.solve",
  "captcha.detect",
  "captcha.inspect",
  "captcha.click",
  "captcha.drag",
  "captcha.readText",
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
  "text), inspect the attached image, click matching tiles or type the text, then " +
  "call `captcha.solve()` again. Fall back to `captcha.inspect`, `captcha.click`, " +
  "`captcha.drag`, `captcha.readText`, or `human.click` when needed. Continue " +
  "through up to three distinct stages of the same challenge. As soon as it " +
  "clears, resume the original action and continue the task. Never repeat the " +
  "same failed action or rotate identities/search engines; after three unresolved " +
  "stages, use a host web-research tool, first-party route, or human handoff.";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  if (value == null) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}

function normalizedText(value) {
  return stringValue(value)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100_000);
}

function parsedUrl(value) {
  try {
    return new URL(stringValue(value));
  } catch {
    return null;
  }
}

function hostIs(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isGoogleHost(host) {
  if (hostIs(host, "google.com")) return true;
  return /(?:^|\.)google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host);
}

function normalizeSource(value, kind, index = null, fallback = {}) {
  const source = isRecord(value) ? value : {};
  return {
    kind,
    index,
    url: stringValue(source.url ?? fallback.url),
    title: stringValue(source.title ?? fallback.title),
    text: stringValue(source.text ?? fallback.text),
    completed: source.completed === true,
  };
}

function normalizeMetadata(metadata) {
  const input = isRecord(metadata) ? metadata : {};
  const nestedMain = [input.main, input.mainPage, input.page].find(isRecord);
  const main = normalizeSource(nestedMain || input, "main", null, input);
  const frameValues = [input.frames, input.childFrames].find(Array.isArray) || [];
  const frames = frameValues
    .filter(isRecord)
    .map((frame, index) => normalizeSource(frame, "frame", index));
  const solvedProviders = new Set(
    (Array.isArray(input.solvedProviders) ? input.solvedProviders : [])
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
  const parsed = parsedUrl(source.url);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const whole = `${path}${parsed.search}${parsed.hash}`.toLowerCase();

  if (isGoogleHost(host) && /^\/sorry(?:\/|$)/.test(path)) {
    return { provider: "google", signal: "google_sorry_url", source };
  }
  if (hostIs(host, "bing.com") && /\/(?:captcha|challenge|turing)(?:\/|$)/.test(path)) {
    return { provider: "bing", signal: "bing_challenge_url", source };
  }

  const recaptchaHost = isGoogleHost(host) || hostIs(host, "recaptcha.net");
  const recaptchaFrame = /\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)(?:\/|$)/.test(
    path,
  );
  if (recaptchaHost && recaptchaFrame) {
    if (!includeInvisible && path.endsWith("/anchor") && explicitInvisible(source.url)) return null;
    return { provider: "recaptcha", signal: "recaptcha_frame_url", source };
  }

  const hcaptchaFrameText = normalizedText(`${source.title}\n${source.text}`);
  const hcaptchaChallengeFrame =
    hostIs(host, "hcaptcha.com") &&
    (/(?:^|[?&#])frame=challenge(?:[&#]|$)/.test(whole) ||
      /(?:^|\/)(?:hcaptcha-)?challenge(?:\.html)?(?:\/|$)/.test(path) ||
      (path.includes("/captcha/") &&
        /(?:please )?(?:click|select|choose) (?:all|each|every|the) (?:image|images|square|squares)\b/.test(
          hcaptchaFrameText,
        )));
  if (hcaptchaChallengeFrame) {
    return { provider: "hcaptcha", signal: "hcaptcha_frame_url", source };
  }

  const cloudflarePlatform = path.includes("/cdn-cgi/challenge-platform/");
  const turnstileFrame =
    hostIs(host, "challenges.cloudflare.com") &&
    (cloudflarePlatform || path.includes("/turnstile/"));
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
export function detectBotChallenge(metadata = {}) {
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

export { PUBLIC_SEARCH_BLOCK_ADVICE, SEARCH_CHALLENGE_ADVICE };
