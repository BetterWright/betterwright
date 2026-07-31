// Fork identity: a realistic consumer macOS fingerprint for the native
// Chromium fork, replacing the host identity (typically a headless Linux
// server, which abuse-score engines weight heavily).

import fs from "node:fs";
import path from "node:path";
//
// Every value below was captured from a real MacBook Pro 14" (Mac16,8,
// Apple M4 Pro, 12 cores, 24 GB, macOS 26.6, 1800x1169@2x scaled display)
// running genuine Google Chrome 150.0.7871.129 — the exact version the fork
// pins. Values are version-parameterized so a future version bump only
// changes BETTERWRIGHT_CHROMIUM_VERSION.
//
// Application is two-layer:
//   1. Chromium layer: launch flags (--fingerprint-platform, window
//      geometry, device scale factor) plus the baseline context userAgent.
//   2. CDP emulation layer: Emulation.setUserAgentOverride with full
//      UserAgentMetadata per page. This is the DevTools emulation protocol —
//      no page-world JavaScript shims, so nothing is observable via getter
//      inspection or Function.prototype.toString probes.
//
// Surfaces CDP cannot reach (WebGL renderer, canvas/audio, hardware
// concurrency on some builds, fonts) are binary patches in the fork tree —
// see docs/chromium-fork-patches.md.

/**
 * Build the macOS identity for a Chromium version.
 * @param {string} chromiumVersion e.g. "150.0.7871.129"
 */
export function forkMacIdentity(chromiumVersion) {
  const version = String(chromiumVersion || "").trim();
  const major = version.split(".")[0];
  return {
    platform: "macos",

    // Headed consumer-Chrome UA (real headless inserts "HeadlessChrome";
    // masked here and by the binary patch).
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,

    // navigator.platform — set through Emulation.setUserAgentOverride's
    // platform parameter, no JS patch required.
    navigatorPlatform: "MacIntel",
    acceptLanguage: "en-US,en",

    // Sec-CH-UA* request headers and navigator.userAgentData, exactly as
    // emitted by real Google Chrome 150 on macOS 26.6 (Apple Silicon).
    userAgentMetadata: {
      brands: [
        { brand: "Not;A=Brand", version: "8" },
        { brand: "Chromium", version: major },
        { brand: "Google Chrome", version: major },
      ],
      fullVersionList: [
        { brand: "Not;A=Brand", version: "8.0.0.0" },
        { brand: "Chromium", version },
        { brand: "Google Chrome", version },
      ],
      fullVersion: version,
      platform: "macOS",
      platformVersion: "26.6.0",
      architecture: "arm",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },

    // M4 Pro: 12 logical cores; deviceMemory is Chrome's bucketed value as
    // reported on the real 24 GB machine.
    hardwareConcurrency: 12,
    deviceMemory: 16,

    // 14" MacBook Pro at the 1800x1169 "More Space" scaled resolution, DPR
    // 2. availHeight 1049 = 1169 - 39px menu bar - 81px visible Dock, the
    // real NSScreen.visibleFrame on the capture machine.
    screen: {
      width: 1800,
      height: 1169,
      availWidth: 1800,
      availHeight: 1049,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: 2,
    },

    // Only patchable in the binary (docs/chromium-fork-patches.md). Captured
    // from the real machine's WebGL2 context.
    webgl: {
      unmaskedVendor: "Google Inc. (Apple)",
      unmaskedRenderer:
        "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)",
    },
  };
}

/**
 * Apply the identity to one page over CDP. Best-effort per command: an
 * unrecognized emulation command on an older fork build must not break
 * page setup.
 */
async function applyForkIdentityToPage(cdp, identity) {
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: identity.userAgent,
    acceptLanguage: identity.acceptLanguage,
    platform: identity.navigatorPlatform,
    userAgentMetadata: identity.userAgentMetadata,
  });
  try {
    await cdp.send("Emulation.setHardwareConcurrencyOverride", {
      hardwareConcurrency: identity.hardwareConcurrency,
    });
  } catch {
    // Not available on all Chromium builds; the binary patch covers it.
  }
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

/**
 * Point the fork's fontconfig at the bundled macOS-metric font set
 * (research/assemble-mac-fonts.sh; ships as <artifact>/fonts/ttf next to the
 * binary). The conf is generated at launch so absolute paths follow wherever
 * the artifact is deployed. Returns null when no font bundle is present —
 * the fork then exposes the host fontconfig, which is a known Linux tell.
 */
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

/**
 * Install the identity on a persistent context: all existing pages plus
 * every page created later. Pair with the context-level `userAgent`
 * baseline so the first navigation of a brand-new page still sends the
 * right User-Agent before its CDP session attaches.
 *
 * Known gaps (binary patch territory): service-worker requests and
 * WebGL/canvas/audio/hardware surfaces.
 */
export async function installForkIdentityEmulation(context, identity) {
  const applyTo = async (page) => {
    try {
      const cdp = await context.newCDPSession(page);
      await applyForkIdentityToPage(cdp, identity);
    } catch {
      // Page closed mid-attach or session refused; identity for that page
      // still carries the context-level userAgent baseline.
    }
  };
  context.on("page", (page) => {
    void applyTo(page);
  });
  await Promise.all(context.pages().map((page) => applyTo(page)));
}
