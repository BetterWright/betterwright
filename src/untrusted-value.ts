// Defensive coercion helpers for values that arrive from page content or model
// input, where any field may be missing, of the wrong type, or hostile.
//
// Page-derived data reaches the host through structured-clone boundaries and
// model-authored tool arguments, so nothing here may assume a shape. Every
// helper is total: it returns a usable value for any input rather than
// throwing, which is what lets the challenge and CAPTCHA classifiers read a
// field without guarding each access at the call site.

/**
 * A value that crossed a trust boundary: page-derived data, model-authored
 * tool arguments, persisted JSON, or dynamic protocol payloads. Structurally
 * it admits every JavaScript value — hostile input has no structure to assume
 * — but unlike a bare `unknown` it names the contract: narrow through the
 * guards below (or a decoder built from them) before relying on any shape.
 * (`NonNullable<unknown>` is `{}`, the one non-nullish type `unknown` assigns
 * to without a cast.)
 */
export type UntrustedValue = NonNullable<unknown> | null | undefined;

/**
 * An untrusted value known to be callable. Parameters are `never` so nothing
 * can be passed to it without the caller first establishing a real signature;
 * its result is as untrusted as the function was.
 */
export type UntrustedFunction = (...args: never[]) => UntrustedValue;

/**
 * Narrow to a plain object, excluding arrays and null. The predicate is
 * deliberately just `object` — properties of an untrusted object carry no
 * types, so they are read through `untrustedField`/`untrustedEntries` below
 * rather than by index access.
 */
export function isRecord(value: UntrustedValue): value is UntrustedValue & object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read one property of an untrusted value with ordinary lookup semantics
 * (prototype chain included, so duck-typing probes see methods), yielding
 * `undefined` for primitives without the property and for hostile getters
 * that throw. `Object(value)` is what keeps this file the single point of
 * dynamic access: the result is typed by the caller narrowing the returned
 * `UntrustedValue`, never by an assumed object shape.
 */
export function untrustedField(value: UntrustedValue, key: string): UntrustedValue {
  if (value === null || value === undefined) return undefined;
  try {
    return Object(value)[key];
  } catch {
    return undefined;
  }
}

/**
 * Own enumerable entries of an untrusted value, `[]` for primitives and for
 * exotic objects whose enumeration throws. Values are as untrusted as the
 * object they came from.
 */
export function untrustedEntries(value: UntrustedValue): Array<[string, UntrustedValue]> {
  if (value === null || value === undefined) return [];
  try {
    return Object.entries(Object(value));
  } catch {
    return [];
  }
}

/** Narrow to a string. */
export function isString(value: UntrustedValue): value is string {
  return typeof value === "string";
}

/** Narrow to a number, including NaN and the infinities. */
export function isNumber(value: UntrustedValue): value is number {
  return typeof value === "number";
}

/** Narrow to a boolean. */
export function isBoolean(value: UntrustedValue): value is boolean {
  return typeof value === "boolean";
}

/** Narrow to something callable (a duck-typing probe, e.g. for thenables). */
export function isCallable(value: UntrustedValue): value is UntrustedFunction {
  return typeof value === "function";
}

/**
 * Coerce to a string, yielding "" for nullish input and for objects whose
 * `toString` throws (a getter on a page-supplied object can).
 */
export function stringValue(value: UntrustedValue): string {
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
export function normalizedText(value: UntrustedValue): string {
  return stringValue(value)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NORMALIZED_TEXT_LENGTH);
}

/** Parse a URL, returning null instead of throwing on anything unparseable. */
export function parsedUrl(value: UntrustedValue): URL | null {
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
