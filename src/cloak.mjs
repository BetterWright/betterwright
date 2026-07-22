import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

let cloakModulePromise = null;

/**
 * Guard against opening a profile that a newer Chromium already upgraded.
 * Chromium records its version in a "Last Version" file and does not downgrade
 * the profile format; an older binary that opens a newer profile crashes during
 * startup (on macOS the crash surfaces deep in the AppKit window/session-restore
 * path as an opaque SIGTRAP). Cloak ships an older Chromium than the stock
 * fallback, so this turns that latent crash into a clear, actionable error.
 * `runningVersion` is a dotted version like "145.0.7632.109"; a missing or
 * unparseable version, or a fresh profile, is a no-op.
 */
export function assertProfileNotNewer(profileDir, runningVersion) {
  const major = (value) => Number.parseInt(String(value || "").split(".")[0], 10);
  const runningMajor = major(runningVersion);
  if (!Number.isFinite(runningMajor)) return;
  let stored;
  try {
    stored = fs.readFileSync(path.join(profileDir, "Last Version"), "utf8").trim();
  } catch {
    return; /* fresh profile, or Chromium has not written the marker yet */
  }
  const profileMajor = major(stored);
  if (Number.isFinite(profileMajor) && profileMajor > runningMajor) {
    throw new Error(
      `Browser profile at ${profileDir} was upgraded by a newer Chromium ` +
        `(${stored}) than the one launching now (${runningVersion}); a newer ` +
        "profile cannot be opened by an older browser. Reset it by removing " +
        "that directory (saved logins there are lost), or launch the matching " +
        "browser version.",
    );
  }
}

function isFreeBinary(binaryInfo, platformPrefix, versionPrefix) {
  return (
    binaryInfo?.tier === "free" &&
    String(binaryInfo?.platform || "").startsWith(platformPrefix) &&
    String(binaryInfo?.version || "").startsWith(versionPrefix)
  );
}

/** Keep known Cloak/X11 viewport combinations coherent and non-zero. */
export function managedCloakViewport(binaryInfo, headless) {
  if (headless && isFreeBinary(binaryInfo, "darwin-", "145.")) {
    return { width: 1438, height: 679 };
  }
  if (!headless && isFreeBinary(binaryInfo, "linux-", "146.")) {
    return { width: 1365, height: 900 };
  }
  return undefined;
}

/** Build the explicit Chromium arguments used by the managed Cloak browser. */
export function managedCloakArgs(fingerprintSeed) {
  return [
    // Chromium suppresses bad-flag infobars for automated test browsers when
    // this recognized switch is present. Cloak/Playwright must retain
    // --no-sandbox for root and container runtimes, where sandboxed Chromium
    // cannot launch.
    "--test-type",
    // WebRTC is not represented by Playwright request routing and can
    // otherwise send STUN/data-channel UDP directly around a TCP proxy.
    // Force it onto the configured proxy/TCP path instead.
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--fingerprint=${fingerprintSeed}`,
  ];
}

/** Native fork arguments: WebRTC proxy boundary plus optional fingerprint seed. */
export function managedChromiumForkArgs(fingerprintSeed) {
  return [
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ...(fingerprintSeed ? [`--fingerprint=${fingerprintSeed}`] : []),
  ];
}

function cloakEntrypoint() {
  const override = (process.env.BETTERWRIGHT_CLOAKBROWSER_PATH || "").trim();
  if (!override) return "cloakbrowser";
  return pathToFileURL(path.join(override, "dist", "index.js")).href;
}

/** Load the official CloakBrowser wrapper without exposing it to model code. */
export async function loadCloakBrowser() {
  if (!cloakModulePromise) {
    cloakModulePromise = import(cloakEntrypoint()).catch((error) => {
      cloakModulePromise = null;
      throw new Error(
        "CloakBrowser is the managed BetterWright browser but its wrapper is not " +
          "available. Run `betterwright setup` to install the managed CloakBrowser runtime.",
        { cause: error },
      );

    });
  }
  return cloakModulePromise;
}

/** Launch a persistent Cloak context while BetterWright retains policy control. */
export async function launchCloakPersistentContext(options) {
  const cloak = await loadCloakBrowser();
  if (typeof cloak.launchPersistentContext !== "function") {
    throw new Error("The installed CloakBrowser wrapper has no persistent-context launcher.");
  }
  return cloak.launchPersistentContext(options);
}

/** Return wrapper-selected binary metadata for narrowly gated compatibility fixes. */
export async function cloakBinaryInfo() {
  const cloak = await loadCloakBrowser();
  if (typeof cloak.binaryInfo !== "function") return null;
  return cloak.binaryInfo();
}
