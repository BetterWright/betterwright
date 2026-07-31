// Defensive coercion helpers for values that arrive from page content or model
// input, where any field may be missing, of the wrong type, or hostile.
//
// Page-derived data reaches the host through structured-clone boundaries and
// model-authored tool arguments, so nothing here may assume a shape. Every
// helper is total: it returns a usable value for any input rather than
// throwing, which is what lets the challenge and CAPTCHA classifiers read a
// field without guarding each access at the call site.

/** Narrow to a plain object, excluding arrays and null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Coerce to a string, yielding "" for nullish input and for objects whose
 * `toString` throws (a getter on a page-supplied object can).
 */
export function stringValue(value: unknown): string {
  if (value == null) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}

const MAX_NORMALIZED_TEXT_LENGTH = 100_000;

/**
 * Fold a page string into a comparable form: lowercase, curly quotes
 * normalized, whitespace collapsed. Capped because the input can be a whole
 * document's text and every caller only ever matches against short patterns.
 */
export function normalizedText(value: unknown): string {
  return stringValue(value)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NORMALIZED_TEXT_LENGTH);
}

/** Parse a URL, returning null instead of throwing on anything unparseable. */
export function parsedUrl(value: unknown): URL | null {
  try {
    return new URL(stringValue(value));
  } catch {
    return null;
  }
}

/**
 * Whether `host` is `domain` or a subdomain of it. Compares labels rather than
 * substrings so `notgoogle.com` never matches `google.com`.
 */
export function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Whether `host` is a Google property, including the country-code domains
 * (google.de, google.co.uk, google.com.au) that serve the same challenge UI.
 */
export function isGoogleHost(host: string): boolean {
  if (hostIs(host, "google.com")) return true;
  return /(?:^|\.)google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host);
}
