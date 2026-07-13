const SEARCH_CHALLENGE_ADVICE =
  "A bot challenge is blocking this page. Do not retry it or rotate through other " +
  "public search engines. Use an available web-research/search tool, navigate " +
  "directly to a likely first-party site, or use the configured CAPTCHA solver once " +
  "when this specific page is necessary.";

export function isPublicSearchNavigation(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const google = host === "google.com" || host.endsWith(".google.com");
    const bing = host === "bing.com" || host.endsWith(".bing.com");
    const duckduckgo = host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
    if (google || bing) return parsed.pathname === "/search";
    return duckduckgo && (parsed.pathname === "/" || parsed.pathname === "/html/");
  } catch {
    return false;
  }
}

function providerFor(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "google.com" || host.endsWith(".google.com")) return "google";
    if (host === "bing.com" || host.endsWith(".bing.com")) return "bing";
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com"))
      return "duckduckgo";
    if (host === "cloudflare.com" || host.endsWith(".cloudflare.com"))
      return "cloudflare";
    return host || "unknown";
  } catch {
    return "unknown";
  }
}

/** Detect a visible CAPTCHA/bot-challenge page without attempting to bypass it. */
export function detectBotChallenge({ url = "", title = "", text = "" } = {}) {
  const haystack = `${url}\n${title}\n${text}`.toLowerCase();
  const urlChallenge =
    /google\.[^/]+\/sorry\//.test(haystack) ||
    /\/recaptcha\//.test(haystack) ||
    /\/cdn-cgi\/challenge-platform\//.test(haystack);
  const textChallenge = [
    "our systems have detected unusual traffic",
    "please solve the challenge below to continue",
    "verify you are human",
    "verify you are a human",
    "i'm not a robot",
    "checking your browser before accessing",
  ].some((marker) => haystack.includes(marker));

  if (!urlChallenge && !textChallenge) return null;
  return {
    type: "bot_challenge",
    provider: providerFor(url),
    url: String(url),
    advice: SEARCH_CHALLENGE_ADVICE,
  };
}

export { SEARCH_CHALLENGE_ADVICE };
