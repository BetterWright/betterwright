// Native-fork identity contract. Capture constants live in a versioned data
// module; this file validates configuration and materializes an immutable
// launch/context profile without changing page-world APIs.

import fs from "node:fs";
import path from "node:path";

import { CHROMIUM_151_MACOS_M4_PRO_PROFILE } from "./fork-identity-profile-151.js";

const CHROMIUM_VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

function canonicalLocale(locale) {
  const configured = String(locale || "").trim();
  if (!configured) throw new TypeError("Fork identity locale must be a non-empty BCP 47 tag.");
  let parsed;
  try {
    parsed = new Intl.Locale(configured);
  } catch {
    throw new TypeError(`Invalid fork identity locale: ${configured}`);
  }
  const canonical = parsed.toString();
  if (canonical.includes("-u-") || canonical.includes("-x-")) {
    throw new TypeError("Fork identity locale must not contain Unicode or private-use extensions.");
  }
  return { canonical, language: parsed.language };
}

/** Derive Chromium's Accept-Language preference from one configured locale. */
export function acceptLanguageForLocale(locale) {
  const { canonical, language } = canonicalLocale(locale);
  return canonical === language ? canonical : `${canonical},${language};q=0.9`;
}

/**
 * Build the immutable Chromium 151 macOS identity contract.
 * The browser version is runtime data; all captured hardware values are
 * sourced from CHROMIUM_151_MACOS_M4_PRO_PROFILE.
 */
export function forkMacIdentity(chromiumVersion, { locale = "en-US" } = {}) {
  const version = String(chromiumVersion || "").trim();
  if (!CHROMIUM_VERSION_PATTERN.test(version)) {
    throw new TypeError(
      `Fork identity Chromium version must have four numeric components; got ${version || "empty"}.`,
    );
  }
  const major = Number(version.split(".")[0]);
  const profile = CHROMIUM_151_MACOS_M4_PRO_PROFILE;
  if (major !== profile.chromiumMajor) {
    throw new RangeError(
      `Identity profile ${profile.id} supports Chromium ${profile.chromiumMajor}, not ${major}.`,
    );
  }
  const { canonical: configuredLocale } = canonicalLocale(locale);
  const grease = profile.userAgentMetadata.greaseBrand;
  const brands = Object.freeze([
    grease,
    Object.freeze({ brand: "Chromium", version: String(major) }),
    Object.freeze({ brand: "Google Chrome", version: String(major) }),
  ]);
  const fullVersionList = Object.freeze([
    Object.freeze({ brand: grease.brand, version: `${grease.version}.0.0.0` }),
    Object.freeze({ brand: "Chromium", version }),
    Object.freeze({ brand: "Google Chrome", version }),
  ]);
  return Object.freeze({
    profileId: profile.id,
    profileSchemaVersion: profile.schemaVersion,
    chromiumVersion: version,
    locale: configuredLocale,
    acceptLanguage: acceptLanguageForLocale(configuredLocale),
    platform: profile.platform,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    navigatorPlatform: profile.navigatorPlatform,
    userAgentMetadata: Object.freeze({
      brands,
      fullVersionList,
      fullVersion: version,
      platform: profile.userAgentMetadata.platform,
      platformVersion: profile.userAgentMetadata.platformVersion,
      architecture: profile.userAgentMetadata.architecture,
      model: profile.userAgentMetadata.model,
      mobile: profile.userAgentMetadata.mobile,
      bitness: profile.userAgentMetadata.bitness,
      wow64: profile.userAgentMetadata.wow64,
    }),
    hardwareConcurrency: profile.hardwareConcurrency,
    deviceMemory: profile.deviceMemory,
    screen: profile.screen,
    media: profile.media,
    webgl: profile.webgl,
    webgpu: profile.webgpu,
  });
}

/** Context options that must agree with the native fork identity at launch. */
export function forkIdentityContextOptions(identity) {
  if (!identity || typeof identity.userAgent !== "string" || !identity.locale) {
    throw new TypeError("A validated fork identity is required.");
  }
  return Object.freeze({
    userAgent: identity.userAgent,
    locale: identity.locale,
    colorScheme: "dark",
  });
}

/** Native launch geometry for the versioned identity capture. */
export function forkIdentityGeometryArgs(identity, { headedInvisible = false } = {}) {
  if (!identity?.screen || identity.profileId !== CHROMIUM_151_MACOS_M4_PRO_PROFILE.id) {
    throw new TypeError("A validated Chromium 151 macOS fork identity is required.");
  }
  const args = [
    `--window-size=${identity.screen.width},${identity.screen.height}`,
    `--force-device-scale-factor=${identity.screen.devicePixelRatio}`,
  ];
  if (headedInvisible) args.push("--window-position=32000,32000");
  return Object.freeze(args);
}

/** Absolute path to the artifact's `fonts/ttf` directory, or null if absent. */
export function forkFontsDir(forkBinary) {
  if (!forkBinary) return null;
  const fontsDir = path.join(path.dirname(forkBinary), "fonts", "ttf");
  try {
    return fs.statSync(fontsDir).isDirectory() ? fontsDir : null;
  } catch {
    return null;
  }
}

export function prepareForkFontsConfig({ forkBinary, runtimeDir }) {
  const fontsDir = forkFontsDir(forkBinary);
  if (!fontsDir) return null;
  const cacheDir = path.join(runtimeDir, "fontconfig-cache");
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const confPath = path.join(runtimeDir, "fonts.conf");
  fs.writeFileSync(
    confPath,
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <cachedir>${cacheDir}</cachedir>
  <match target="pattern"><test name="family"><string>sans-serif</string></test><edit name="family" mode="prepend" binding="strong"><string>Helvetica Neue</string></edit></match>
  <match target="pattern"><test name="family"><string>serif</string></test><edit name="family" mode="prepend" binding="strong"><string>Times New Roman</string></edit></match>
  <match target="pattern"><test name="family"><string>monospace</string></test><edit name="family" mode="prepend" binding="strong"><string>Menlo</string></edit></match>
</fontconfig>
`,
    { mode: 0o600 },
  );
  return { confPath, cacheDir, fontsDir };
}
