import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BETTERWRIGHT_CHROMIUM_VERSION = "151.0.7922.108";
export const BETTERCHROMIUM_PRODUCT_NAME = "BetterChromium";

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
    "BetterChromium.app",
    "Contents",
    "MacOS",
    "BetterChromium",
  ),
  "linux-x64": path.join("linux-x64", "betterchromium"),
  "win32-x64": path.join("win-x64", "betterchromium.exe"),
});

/** GitHub release that hosts the per-platform fork zip artifacts. */
export const CHROMIUM_FORK_RELEASE_TAG = `betterchromium-${BETTERWRIGHT_CHROMIUM_VERSION}-r2`;

/**
 * Public download manifest for `betterwright update` / default `setup`.
 * SHA-256 pins are of the zip archives on the release, not the nested binary.
 */
export const CHROMIUM_FORK_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "betterchromium-mac-arm64.zip",
    sha256:
      "22484b810c601697afd7d0a82f39ced7f24ac7d8a2b01e52c5a61e9a6096ec67",
  }),
  "linux-x64": Object.freeze({
    name: "betterchromium-linux-x64.zip",
    sha256:
      "e3fbe6ff7110e3033e1f7f1475447e354bd345343005b1ee2825248e46077559",
  }),
  "win32-x64": Object.freeze({
    name: "betterchromium-win-x64.zip",
    sha256:
      "03d8abb5d6064bbd808cf52c2a327692502c4ca6c565b2e1cdb639200c52dccb",
  }),
});

function configuredValue(value) {
  return String(value || "").trim();
}

/** Explicit backend preference, or automatic policy when unset. */
export function configuredBrowserBackend(env = process.env) {
  const value = configuredValue(env.BETTERWRIGHT_BACKEND).toLowerCase();
  if (!value || value === "auto") return "auto";
  if (value === "chromium-fork" || value === "cloak") return value;
  throw new Error(
    "BETTERWRIGHT_BACKEND must be auto, chromium-fork, or cloak; " +
      `received ${JSON.stringify(value)}.`,
  );
}

/** Whether BetterWright publishes a native BetterChromium artifact here. */
export function chromiumForkPlatformSupported({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return Object.hasOwn(PLATFORM_LAYOUT, `${platform}-${arch}`);
}

/**
 * Select the managed browser after native-binary resolution.
 *
 * A host for which no artifact is published uses CloakBrowser automatically,
 * matching the compatibility behavior BetterWright had before 1.8.0. A
 * supported Linux host without an accessible render device also uses Cloak so
 * it retains a working WebGL surface. A supported host with a missing artifact
 * stays unavailable so a broken native install or sandbox mount cannot silently
 * downgrade. Explicit paths and roots remain strict during resolution. In auto
 * mode, Linux render-device accessibility decides whether the resolved binary
 * is safe to launch; an explicit backend preference wins that heuristic.
 */
export function selectManagedBrowserBackend({
  chromiumFork = null,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  softwareGpu = false,
} = {}) {
  const preference = configuredBrowserBackend(env);
  const explicitPath = configuredValue(env.BETTERWRIGHT_CHROMIUM_PATH);
  const explicitRoot = configuredValue(env.BETTERWRIGHT_CHROMIUM_ROOT);
  if (preference === "cloak") {
    return {
      browser: "cloak",
      cloakFallback: "explicit",
      selectionReason: "forced-cloak",
    };
  }
  if (preference === "chromium-fork") {
    return chromiumFork
      ? {
          browser: "chromium-fork",
          cloakFallback: null,
          selectionReason: "forced-chromium-fork",
        }
      : {
          browser: "unavailable",
          cloakFallback: null,
          selectionReason: "forced-chromium-fork-missing",
        };
  }
  if (
    explicitPath.toLowerCase() === "off" ||
    explicitRoot.toLowerCase() === "off"
  ) {
    return {
      browser: "cloak",
      cloakFallback: "explicit",
      selectionReason: "legacy-off",
    };
  }

  if (chromiumFork) {
    if (softwareGpu) {
      return {
        browser: "cloak",
        cloakFallback: "gpu-unavailable",
        selectionReason: "render-device-unavailable",
      };
    }
    return {
      browser: "chromium-fork",
      cloakFallback: null,
      selectionReason: "native-available",
    };
  }

  // A custom path/root is resolved strictly before this selector runs. Never
  // interpret an invalid explicit configuration as permission to fall back.
  if (explicitPath || explicitRoot) {
    return {
      browser: "unavailable",
      cloakFallback: null,
      selectionReason: "explicit-native-unavailable",
    };
  }

  if (!chromiumForkPlatformSupported({ platform, arch })) {
    return {
      browser: "cloak",
      cloakFallback: "unsupported-platform",
      selectionReason: "unsupported-platform",
    };
  }
  return {
    browser: "unavailable",
    cloakFallback: null,
    selectionReason: "native-missing",
  };
}

/** Result warning that makes every non-default backend decision observable. */
export function browserSelectionWarning(selection, { softwareGpu = false } = {}) {
  if (selection.selectionReason === "forced-chromium-fork") {
    return softwareGpu
      ? "Browser backend: BetterChromium, forced by BETTERWRIGHT_BACKEND=chromium-fork even though no accessible Linux render device was found; verify WebGL in this sandbox."
      : "Browser backend: BetterChromium, forced by BETTERWRIGHT_BACKEND=chromium-fork.";
  }
  if (selection.selectionReason === "forced-cloak") {
    return "Browser backend: CloakBrowser, forced by BETTERWRIGHT_BACKEND=cloak.";
  }
  if (selection.selectionReason === "render-device-unavailable") {
    return (
      "Browser backend: CloakBrowser compatibility mode because no accessible Linux " +
      "render device was found. In a container or OS sandbox, set " +
      "BETTERWRIGHT_BACKEND=chromium-fork to override this mount-based probe."
    );
  }
  if (selection.selectionReason === "unsupported-platform") {
    return "Browser backend: CloakBrowser compatibility mode because this platform has no published BetterChromium artifact.";
  }
  if (selection.selectionReason === "legacy-off") {
    return "Browser backend: CloakBrowser because BETTERWRIGHT_CHROMIUM_PATH or BETTERWRIGHT_CHROMIUM_ROOT is set to off.";
  }
  return "";
}

/** Where deployments drop the fork artifact for zero-config discovery. */
export function defaultChromiumForkRoot({ home = os.homedir() } = {}) {
  return path.join(home, ".betterwright", "chromium");
}

/**
 * Resolve the pinned fork binary without changing BetterWright's public API.
 *
 * Resolution order:
 *  1. BETTERWRIGHT_BACKEND (forced Cloak needs no native path; forced native
 *     conflicts with a legacy "off" path/root).
 *  2. BETTERWRIGHT_CHROMIUM_PATH / BETTERWRIGHT_CHROMIUM_ROOT (strict: a
 *     configured-but-missing binary is an error).
 *  3. The default root (~/.betterwright/chromium) — if the artifact for this
 *     platform exists there, use it silently. Backend selection routes hosts
 *     without a published artifact to managed CloakBrowser.
 *  4. Either path variable set to "off" forces managed CloakBrowser in auto
 *     mode.
 */
export function resolveChromiumForkBinary({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const preference = configuredBrowserBackend(env);
  const explicit = configuredValue(env.BETTERWRIGHT_CHROMIUM_PATH);
  let root = configuredValue(env.BETTERWRIGHT_CHROMIUM_ROOT);
  if (preference === "cloak") return null;
  if (
    explicit.toLowerCase() === "off" ||
    root.toLowerCase() === "off"
  ) {
    if (preference === "chromium-fork") {
      throw new Error(
        "BETTERWRIGHT_BACKEND=chromium-fork conflicts with " +
          "BETTERWRIGHT_CHROMIUM_PATH/ROOT=off.",
      );
    }
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
      if (implicit) return null; // runtime reports the unsupported native backend
      throw new Error(
        `No BetterChromium artifact layout for ${platform}-${arch}.`,
      );
    }
    candidate = path.join(root, layout);
  }

  if (!existsSync(candidate)) {
    if (implicit) return null; // runtime reports the missing required backend
    throw new Error(`BetterChromium binary not found: ${candidate}`);
  }
  return candidate;
}
