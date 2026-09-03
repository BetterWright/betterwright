import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isCallable } from "./untrusted-value.js";

export const BETTERWRIGHT_CHROMIUM_VERSION = "151.0.7922.108";

/**
 * Chromium's Windows launcher uses a private side-by-side assembly to locate
 * chrome_elf.dll. The executable embeds a dependency whose name is the full
 * Chromium version, and this companion manifest satisfies that dependency.
 */
export function windowsVersionAssemblyManifest(
  version = BETTERWRIGHT_CHROMIUM_VERSION,
) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid BetterChromium Windows assembly version: ${version}`);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">\n' +
    `  <assemblyIdentity name="${version}" version="${version}" type="win32"/>\n` +
    '  <file name="chrome_elf.dll"/>\n' +
    '</assembly>\n'
  );
}

function validWindowsVersionAssemblyManifest(source, version) {
  const identities = String(source).match(/<assemblyIdentity\b[^>]*>/gi) || [];
  const identity = identities.find((entry) =>
    new RegExp(`\\bname=["']${version.replaceAll(".", "\\.")}["']`, "i").test(entry) &&
    new RegExp(`\\bversion=["']${version.replaceAll(".", "\\.")}["']`, "i").test(entry) &&
    /\btype=["']win32["']/i.test(entry)
  );
  return Boolean(identity) &&
    /<file\b[^>]*\bname=["']chrome_elf\.dll["'][^>]*>/i.test(String(source));
}

/**
 * Validate or repair the private assembly beside the Windows launcher.
 * Automatic repair is reserved for BetterWright-owned managed installations;
 * explicit operator paths are only validated and never mutated.
 */
export function ensureWindowsChromiumAssembly({
  binaryPath = "",
  platform = process.platform,
  version = BETTERWRIGHT_CHROMIUM_VERSION,
  repair = false,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  if (platform !== "win32") return { manifest: null, repaired: false };
  if (!binaryPath) throw new Error("A BetterChromium binary path is required.");
  const expectedManifest = windowsVersionAssemblyManifest(version);

  const directory = path.dirname(binaryPath);
  const chromeElf = path.join(directory, "chrome_elf.dll");
  const manifest = path.join(directory, `${version}.manifest`);
  if (!existsSync(chromeElf)) {
    throw new Error(
      `BetterChromium Windows installation is incomplete: chrome_elf.dll is missing beside ${binaryPath}. ` +
        "Run `betterwright setup` to reinstall it.",
    );
  }

  let valid = false;
  if (existsSync(manifest)) {
    try {
      valid = validWindowsVersionAssemblyManifest(
        readFileSync(manifest, "utf8"),
        version,
      );
    } catch {
      valid = false;
    }
  }
  if (valid) return { manifest, repaired: false };
  if (!repair) {
    throw new Error(
      `BetterChromium Windows side-by-side manifest is missing or invalid: ${manifest}. ` +
        "Run `betterwright setup` to repair the managed install, or replace the configured custom artifact.",
    );
  }

  try {
    writeFileSync(manifest, expectedManifest, {
      encoding: "utf8",
      mode: 0o644,
    });
  } catch (error) {
    throw new Error(
      `Could not repair BetterChromium's Windows side-by-side manifest at ${manifest}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        "Run `betterwright setup --force` from a writable account.",
    );
  }
  try {
    valid = validWindowsVersionAssemblyManifest(
      readFileSync(manifest, "utf8"),
      version,
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new Error(
      `BetterChromium Windows side-by-side manifest repair did not produce a valid file at ${manifest}. ` +
        "Run `betterwright setup --force`.",
    );
  }
  return { manifest, repaired: true };
}

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
  const runningAsRoot = isCallable(getuid) && getuid.call(process) === 0;
  return {
    viewport: null,
    ignoreDefaultArgs: [...PLAYWRIGHT_BEHAVIORAL_DEFAULT_ARGS],
    // Dark color scheme via Chromium's native media emulation (no page shim).
    // A light-scheme default is CreepJS's "prefersLightColor" like-headless
    // tell; the fork's ActiveText and scrollbar patches already resolve against
    // the dark appearance, so this keeps the page-reported scheme coherent.
    colorScheme: "dark",
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
export const CHROMIUM_FORK_RELEASE_TAG = `betterchromium-${BETTERWRIGHT_CHROMIUM_VERSION}-r3`;

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
      "3eabe54aae9d8bde34170a6930df21932325be4570baf9d45431baad6cd03d98",
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
  if (value === "chromium-fork") return value;
  throw new Error(
    "BETTERWRIGHT_BACKEND must be auto or chromium-fork; " +
      `received ${JSON.stringify(value)}. (CloakBrowser support was removed; ` +
      "the managed BetterChromium fork is the only bundled backend — see " +
      "docs/browser-providers.md for connecting your own or a cloud browser.)",
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
 * The BetterChromium fork is the only bundled backend. A supported host with
 * a missing artifact stays unavailable (a broken native install or sandbox
 * mount must not silently downgrade), and a host with no published artifact is
 * directed to run setup or bring its own browser via the provider option. On
 * GPU-less Linux hosts the fork launches anyway — its SwiftShader fallback
 * keeps WebGL working without hardware GL.
 */
export function selectManagedBrowserBackend({
  chromiumFork = null,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  softwareGpu = false,
} = {}) {
  configuredBrowserBackend(env); // validates; BETTERWRIGHT_BACKEND is advisory
  const explicitPath = configuredValue(env.BETTERWRIGHT_CHROMIUM_PATH);
  const explicitRoot = configuredValue(env.BETTERWRIGHT_CHROMIUM_ROOT);
  if (
    explicitPath.toLowerCase() === "off" ||
    explicitRoot.toLowerCase() === "off"
  ) {
    // A legacy "off" used to select a bundled fallback browser. There is no
    // fallback now, and silently launching the default fork would ignore the
    // host's explicit instruction.
    return {
      browser: "unavailable",
      selectionReason: "legacy-off",
    };
  }

  if (chromiumFork) {
    return {
      browser: "chromium-fork",
      selectionReason: softwareGpu ? "software-gpu" : "native-available",
    };
  }

  // A custom path/root is resolved strictly before this selector runs. Never
  // interpret an invalid explicit configuration as permission to fall back.
  if (explicitPath || explicitRoot) {
    return {
      browser: "unavailable",
      selectionReason: "explicit-native-unavailable",
    };
  }

  if (!chromiumForkPlatformSupported({ platform, arch })) {
    return {
      browser: "unavailable",
      selectionReason: "unsupported-platform",
    };
  }
  return {
    browser: "unavailable",
    selectionReason: "native-missing",
  };
}

/** Result warning that makes every non-default backend decision observable. */
export function browserSelectionWarning(selection, { softwareGpu: _softwareGpu = false } = {}) {
  if (selection.selectionReason === "software-gpu") {
    return (
      "Browser backend: BetterChromium with SwiftShader software WebGL — no " +
      "accessible Linux render device was found, so GL runs on the CPU."
    );
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
 *  1. BETTERWRIGHT_CHROMIUM_PATH / BETTERWRIGHT_CHROMIUM_ROOT (strict: a
 *     configured-but-missing binary is an error; "off" is rejected as a
 *     leftover fallback toggle).
 *  2. The default root (~/.betterwright/chromium) — if the artifact for this
 *     platform exists there, use it silently.
 */
export function resolveChromiumForkBinary({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  configuredBrowserBackend(env); // validates the variable's value
  const explicit = configuredValue(env.BETTERWRIGHT_CHROMIUM_PATH);
  let root = configuredValue(env.BETTERWRIGHT_CHROMIUM_ROOT);
  if (
    explicit.toLowerCase() === "off" ||
    root.toLowerCase() === "off"
  ) {
    throw new Error(
      "BETTERWRIGHT_CHROMIUM_PATH/ROOT=off selected a bundled fallback that " +
        "no longer exists. Unset it to use the managed BetterChromium fork, " +
        "or pass the provider option to use your own browser " +
        "(docs/browser-providers.md).",
    );
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
  ensureWindowsChromiumAssembly({
    binaryPath: candidate,
    platform,
    repair: implicit,
    existsSync,
    readFileSync,
    writeFileSync,
  });
  return candidate;
}
