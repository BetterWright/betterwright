// Cloaking V2 — launch profile builder.
//
// Implements the two-layer doctrine for the managed browser:
//
//   1. Chromium layer: the CloakBrowser fork carries the source-level patches
//      and this module feeds it a coherent identity (fingerprint seed, locale,
//      timezone) without monkey-patching browser APIs in JavaScript.
//   2. IP layer: an optional upstream proxy chained through the local guard
//      proxy (policy still enforced per connection), with timezone/locale
//      resolved to match the egress IP so the network layer and the JS layer
//      tell the same story.
//
// Headless parity comes from the patched binary plus BetterWright's existing
// binary-specific viewport compatibility layer.
// Page-world shims are intentionally avoided: live reCAPTCHA verification
// showed that the old init pack made Cloak easier, not harder, to detect.

/** Window sizes used only when parking a headed browser off-screen. */
const HEADED_WINDOW_SIZES = Object.freeze({
  macos: Object.freeze({
    width: 1920,
    height: 1015,
  }),
  windows: Object.freeze({
    width: 1920,
    height: 1040,
  }),
});

const COUNTRY_LOCALE = Object.freeze({
  US: "en-US", GB: "en-GB", CA: "en-CA", AU: "en-AU", NZ: "en-NZ", IE: "en-IE",
  DE: "de-DE", AT: "de-AT", CH: "de-CH", FR: "fr-FR", BE: "fr-BE", ES: "es-ES",
  MX: "es-MX", AR: "es-AR", IT: "it-IT", NL: "nl-NL", PT: "pt-PT", BR: "pt-BR",
  PL: "pl-PL", SE: "sv-SE", NO: "nb-NO", DK: "da-DK", FI: "fi-FI", JP: "ja-JP",
  KR: "ko-KR", SG: "en-SG", HK: "zh-HK", TW: "zh-TW", IN: "en-IN", IL: "he-IL",
  ZA: "en-ZA", AE: "ar-AE", TR: "tr-TR", RU: "ru-RU", UA: "uk-UA", CZ: "cs-CZ",
});

/** Chromium args V2 adds on top of the base managed set. */
export function v2LaunchArgs({
  locale,
  timezone,
  platform = "macos",
  headedInvisible = false,
  nativeFork = false,
} = {}) {
  const args = [];
  if (locale) {
    args.push(`--lang=${locale}`, `--fingerprint-locale=${locale}`);
  }
  if (timezone) {
    args.push(
      nativeFork
        ? `--bw-timezone=${timezone}`
        : `--fingerprint-timezone=${timezone}`,
    );
  }
  if (platform) {
    // The fork shares the --fingerprint-* flag namespace: platform masking is
    // honored by fork builds carrying the platform patch set
    // (docs/chromium-fork-patches.md) and is harmless on builds without it.
    args.push(`--fingerprint-platform=${platform}`);
  }
  if (headedInvisible) {
    // Headed-but-invisible: a real window with headed compositing parked off
    // the visible desktop.
    const size = HEADED_WINDOW_SIZES[platform] || HEADED_WINDOW_SIZES.macos;
    args.push(
      `--window-size=${size.width},${size.height}`,
      "--window-position=32000,32000",
    );
  }
  return args;
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
} = {}) {
  const result = { locale: locale || null, timezone: timezone || null, source: "explicit" };
  if (!geoip || (locale && timezone)) return result;
  if (typeof fetchJson !== "function") return result;
  try {
    const data = await fetchJson(lookupUrl);
    if (data?.status !== "success") return result;
    if (!timezone && typeof data.timezone === "string" && data.timezone) {
      result.timezone = data.timezone;
    }
    if (!locale && typeof data.countryCode === "string") {
      result.locale = COUNTRY_LOCALE[data.countryCode.toUpperCase()] || "en-US";
    }
    result.source = "geoip";
    return result;
  } catch {
    return result;
  }
}

/**
 * Full V2 launch plan for the worker. Viewport selection remains in cloak.mjs,
 * where it can be gated to the exact managed binary build.
 */
export function buildV2LaunchPlan({
  platform,
  locale = "en-US",
  timezone,
  headedInvisible = false,
  nativeFork = false,
} = {}) {
  // The native fork masks the host platform as a consumer Mac by default: a
  // headless-Linux identity is a strong automation signal. The managed
  // CloakBrowser path keeps its host-derived coherent identity.
  const resolvedPlatform =
    platform ||
    (nativeFork
      ? "macos"
      : process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : "linux");
  return {
    args: v2LaunchArgs({
      locale,
      timezone,
      platform: resolvedPlatform,
      headedInvisible,
      nativeFork,
    }),
    identity: { locale, timezone: timezone || null, platform: resolvedPlatform },
  };
}
