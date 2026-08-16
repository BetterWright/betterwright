// Launch identity — coherent locale/timezone for the managed browser.
//
// Two layers tell the same story:
//
//   1. Chromium layer: the BetterChromium fork carries the source-level
//      patches and this module feeds it a coherent identity (fingerprint seed,
//      locale, timezone) without monkey-patching browser APIs in JavaScript.
//   2. IP layer: an optional upstream proxy chained through the local guard
//      proxy (policy still enforced per connection), with timezone/locale
//      resolved to match the egress IP so the network layer and the JS layer
//      agree.
//
// The fork presents its real host identity: no platform is masked as another
// operating system — a Linux host is a Linux browser. Page-world APIs remain
// native; this module only configures browser launch and context data.

import { isCallable, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

const SUPPORTED_PLATFORMS = new Set(["macos", "windows", "linux"]);

const COUNTRY_LOCALE = Object.freeze({
  US: "en-US", GB: "en-GB", CA: "en-CA", AU: "en-AU", NZ: "en-NZ", IE: "en-IE",
  DE: "de-DE", AT: "de-AT", CH: "de-CH", FR: "fr-FR", BE: "fr-BE", ES: "es-ES",
  MX: "es-MX", AR: "es-AR", IT: "it-IT", NL: "nl-NL", PT: "pt-PT", BR: "pt-BR",
  PL: "pl-PL", SE: "sv-SE", NO: "nb-NO", DK: "da-DK", FI: "fi-FI", JP: "ja-JP",
  KR: "ko-KR", SG: "en-SG", HK: "zh-HK", TW: "zh-TW", IN: "en-IN", IL: "he-IL",
  ZA: "en-ZA", AE: "ar-AE", TR: "tr-TR", RU: "ru-RU", UA: "uk-UA", CZ: "cs-CZ",
});

function canonicalLocale(locale) {
  const configured = String(locale || "").trim();
  if (!configured) throw new TypeError("Browser identity locale must be a non-empty BCP 47 tag.");
  let parsed;
  try {
    parsed = new Intl.Locale(configured);
  } catch {
    throw new TypeError(`Invalid browser identity locale: ${configured}`);
  }
  const canonical = parsed.toString();
  if (canonical.includes("-u-") || canonical.includes("-x-")) {
    throw new TypeError("Browser identity locale must not contain Unicode or private-use extensions.");
  }
  return { canonical, language: parsed.language };
}

/** Derive Chromium's Accept-Language preference from one configured locale. */
export function acceptLanguageForLocale(locale) {
  const { canonical, language } = canonicalLocale(locale);
  return canonical === language ? canonical : `${canonical},${language};q=0.9`;
}

function validatePlatform(platform) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new TypeError(`Unsupported browser identity platform: ${platform}`);
  }
  return platform;
}

function validateTimezone(timezone) {
  if (!timezone) return null;
  const configured = String(timezone).trim();
  if (!configured) throw new TypeError("Browser identity timezone must not be blank.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: configured }).format();
  } catch {
    throw new TypeError(`Invalid browser identity timezone: ${configured}`);
  }
  return configured;
}

/** The host's own platform as an identity value. */
export function hostPlatform(processPlatform = process.platform) {
  return processPlatform === "darwin"
    ? "macos"
    : processPlatform === "win32"
      ? "windows"
      : "linux";
}

/** Window sizes used only when parking a headed browser off-screen. */
const HEADED_WINDOW_SIZES = Object.freeze({
  macos: Object.freeze({ width: 1512, height: 982 }),
  windows: Object.freeze({ width: 1920, height: 1040 }),
  linux: Object.freeze({ width: 1920, height: 1040 }),
});

/** Chromium args the identity layer adds on top of the base managed set. */
export function identityLaunchArgs({
  locale,
  timezone,
  platform = null,
  headedInvisible = false,
}: any = {}) {
  const args = [];
  const resolvedPlatform = platform ? validatePlatform(platform) : hostPlatform();
  const configuredLocale = locale
    ? acceptLanguageForLocale(locale).split(",", 1)[0]
    : null;
  const configuredTimezone = validateTimezone(timezone);
  if (configuredLocale) {
    args.push(
      `--lang=${configuredLocale}`,
      `--fingerprint-locale=${configuredLocale}`,
    );
  }
  if (configuredTimezone) {
    // The fork's source-level timezone patch (docs/chromium-fork-patches.md).
    args.push(`--bw-timezone=${configuredTimezone}`);
  }
  // The --fingerprint-platform flag stays available as an explicit override
  // for builds carrying the platform patch set; it is no longer defaulted
  // away from the host, because the fork presents its real host identity.
  args.push(`--fingerprint-platform=${resolvedPlatform}`);
  if (headedInvisible) {
    // Headed-but-invisible: a real window with headed compositing parked off
    // the visible desktop.
    const size = HEADED_WINDOW_SIZES[resolvedPlatform];
    args.push(
      `--window-size=${size.width},${size.height}`,
      "--window-position=32000,32000",
    );
  }
  return args;
}

// The injected lookup's contract; only callability is checked, and the JSON it
// resolves with is treated as untrusted network data either way.
function isGeoLookup(value: UntrustedValue): value is (url: string) => Promise<UntrustedValue> {
  return isCallable(value);
}

/**
 * Resolve the egress-IP identity through the upstream proxy. The JS layer must
 * not disagree with the network layer: a Frankfurt exit paired with an
 * America/New_York timezone creates an avoidable inconsistency.
 *
 * `fetchJson(url)` is injectable for tests; production uses a plain HTTP GET
 * through the upstream proxy. Any failure falls back to the caller's explicit
 * values (or no spoof) — a missed geo lookup must never block a launch.
 */
export async function resolveGeoIdentity({
  geoip = false,
  locale,
  timezone,
  lookupUrl = "http://ip-api.com/json/?fields=status,countryCode,timezone",
  fetchJson,
}: any = {}) {
  const result = { locale: locale || null, timezone: timezone || null, source: "explicit" };
  if (!geoip || (locale && timezone)) return result;
  if (!isGeoLookup(fetchJson)) return result;
  try {
    const data = await fetchJson(lookupUrl);
    if (untrustedField(data, "status") !== "success") return result;
    const geoTimezone = untrustedField(data, "timezone");
    if (!timezone && isString(geoTimezone) && geoTimezone) {
      result.timezone = geoTimezone;
    }
    const countryCode = untrustedField(data, "countryCode");
    if (!locale && isString(countryCode)) {
      result.locale = COUNTRY_LOCALE[countryCode.toUpperCase()] || "en-US";
    }
    result.source = "geoip";
    return result;
  } catch {
    return result;
  }
}

/**
 * Full launch plan for the worker: args plus the identity record the caller
 * may consult for context options.
 */
export function buildLaunchIdentityPlan({
  platform,
  locale = "en-US",
  timezone,
  headedInvisible = false,
}: any = {}) {
  // Default is the host's own platform: the fork's source patches keep a
  // headless Linux browser coherent as a Linux desktop browser, which beats
  // claiming hardware the process is not running on.
  const resolvedPlatform = platform ? validatePlatform(platform) : hostPlatform();
  const acceptLanguage = acceptLanguageForLocale(locale);
  const configuredLocale = acceptLanguage.split(",", 1)[0];
  const configuredTimezone = validateTimezone(timezone);
  return {
    args: identityLaunchArgs({
      locale: configuredLocale,
      timezone: configuredTimezone,
      platform: resolvedPlatform,
      headedInvisible,
    }),
    identity: Object.freeze({
      locale: configuredLocale,
      acceptLanguage,
      timezone: configuredTimezone,
      platform: resolvedPlatform,
    }),
  };
}
