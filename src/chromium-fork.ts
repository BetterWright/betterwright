import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BETTERWRIGHT_CHROMIUM_VERSION = "150.0.7871.129";

// Playwright 1.61.1 defaults that deliberately change normal browser behavior.
// Keep its lifecycle, profile, proxy, and CDP-pipe arguments, but let the fork
// run the same web-platform features and foreground/background policies as a
// user-launched Chromium session.
const PLAYWRIGHT_BEHAVIORAL_DEFAULT_ARGS = Object.freeze([
  "--disable-field-trial-config",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--no-service-autorun",
  "--disable-sync",
]);

/** Preserve native metrics and normal browser behavior around Playwright's CDP pipe. */
export function chromiumForkContextOptions({
  platform = process.platform,
  getuid = process.getuid,
} = {}) {
  const runningAsRoot =
    typeof getuid === "function" && getuid.call(process) === 0;
  return {
    viewport: null,
    ignoreDefaultArgs: [...PLAYWRIGHT_BEHAVIORAL_DEFAULT_ARGS],
    // Chromium refuses its Linux sandbox as uid 0. Everywhere else, retain the
    // normal production sandbox rather than Playwright's test-runner default.
    chromiumSandbox: platform !== "linux" || !runningAsRoot,
  };
}

export const PLATFORM_LAYOUT = Object.freeze({
  "darwin-arm64": path.join(
    "mac-arm64",
    "Chromium.app",
    "Contents",
    "MacOS",
    "Chromium",
  ),
  "linux-x64": path.join("linux-x64", "chrome"),
  "win32-x64": path.join("win-x64", "chrome.exe"),
});

/** GitHub release that hosts the per-platform fork zip artifacts. */
export const CHROMIUM_FORK_RELEASE_TAG = `chromium-${BETTERWRIGHT_CHROMIUM_VERSION}`;

/**
 * Public download manifest for `betterwright update` / default `setup`.
 * SHA-256 pins are of the zip archives on the release, not the nested binary.
 */
export const CHROMIUM_FORK_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "betterwright-chromium-mac-arm64.zip",
    sha256:
      "074cefbde9a8cf10f2ee15cddb1ac67613ebda3b1549e8948ad9eeafbe522ad6",
  }),
  "linux-x64": Object.freeze({
    name: "betterwright-chromium-linux-x64.zip",
    sha256:
      "45ffef258415057d70b71639424dc681284babf533939d32375f99585a136d31",
  }),
  "win32-x64": Object.freeze({
    name: "betterwright-chromium-win-x64.zip",
    sha256:
      "977cb811fdc7198723865b741b24da329128d5d1d519f5599e2b4cb1b9dadafa",
  }),
});

function configuredValue(value) {
  return String(value || "").trim();
}

/** Where deployments drop the fork artifact for zero-config discovery. */
export function defaultChromiumForkRoot({ home = os.homedir() } = {}) {
  return path.join(home, ".betterwright", "chromium");
}

/**
 * Resolve the pinned fork binary without changing BetterWright's public API.
 *
 * Resolution order:
 *  1. BETTERWRIGHT_CHROMIUM_PATH / BETTERWRIGHT_CHROMIUM_ROOT (strict: a
 *     configured-but-missing binary is an error).
 *  2. The default root (~/.betterwright/chromium) — if the artifact for this
 *     platform exists there, use it silently. Platforms without a shipped
 *     artifact fall through to managed CloakBrowser.
 *  3. Either variable set to "off" forces the managed CloakBrowser path.
 */
export function resolveChromiumForkBinary({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const explicit = configuredValue(env.BETTERWRIGHT_CHROMIUM_PATH);
  let root = configuredValue(env.BETTERWRIGHT_CHROMIUM_ROOT);
  if (
    explicit.toLowerCase() === "off" ||
    root.toLowerCase() === "off"
  ) {
    return null;
  }

  let implicit = false;
  if (!explicit && !root) {
    root = defaultChromiumForkRoot({ home });
    implicit = true;
  }

  let candidate;
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error("BETTERWRIGHT_CHROMIUM_PATH must be an absolute path.");
    }
    candidate = explicit;
  } else {
    if (!implicit && !path.isAbsolute(root)) {
      throw new Error("BETTERWRIGHT_CHROMIUM_ROOT must be an absolute path.");
    }
    const layout = PLATFORM_LAYOUT[`${platform}-${arch}`];
    if (!layout) {
      if (implicit) return null; // no artifact for this platform: managed path
      throw new Error(
        `No BetterWright Chromium artifact layout for ${platform}-${arch}.`,
      );
    }
    candidate = path.join(root, layout);
  }

  if (!existsSync(candidate)) {
    if (implicit) return null; // artifact not deployed here: managed path
    throw new Error(`BetterWright Chromium binary not found: ${candidate}`);
  }
  return candidate;
}
