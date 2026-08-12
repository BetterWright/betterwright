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
        "profile cannot be opened by an older browser. This usually means the " +
        "profile was created by the other managed backend — the Chromium fork " +
        "and CloakBrowser ship different Chromium versions and cannot share " +
        `one profile. Fix it with \`rm -rf ${profileDir}\` and sign in again ` +
        "(logins saved in that profile are lost; vault credentials are not), " +
        "or point BETTERWRIGHT_HOME at a separate directory per backend.",
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
  // Cloak 145's macOS free build inherits the host window size even when the
  // browser advertises a smaller 1440x900 screen. In headed mode that can make
  // innerHeight larger than screen.height; use the same known-good viewport in
  // both modes so geometry stays internally coherent.
  if (isFreeBinary(binaryInfo, "darwin-", "145.")) {
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

/** Whether Linux lacks an accessible hardware-rendering device. */
export function chromiumForkNeedsSoftwareGpu({
  platform = process.platform,
  readdirSync = fs.readdirSync,
  accessSync = fs.accessSync,
} = {}) {
  if (platform !== "linux") return false;
  let devices = [];
  try {
    devices = readdirSync("/dev/dri")
      .filter((name) => /^(?:renderD|card)\d+$/.test(name))
      .map((name) => path.join("/dev/dri", name));
  } catch {
    return true;
  }
  for (const device of devices) {
    try {
      accessSync(device, fs.constants.R_OK | fs.constants.W_OK);
      return false;
    } catch {
      /* try the next DRI device */
    }
  }
  return true;
}

/** Native fork arguments: guarded WebRTC, graphics, and fingerprint seed. */
export function managedChromiumForkArgs(
  fingerprintSeed,
  { softwareGpu = chromiumForkNeedsSoftwareGpu() }: any = {},
) {
  return [
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    // Chromium 151 no longer guarantees automatic software WebGL fallback.
    // On Linux hosts without an accessible DRI device, explicitly use the
    // packaged SwANGLE renderer so ordinary WebGL remains available. This is
    // the normal ANGLE GL driver, not the lower-security
    // --enable-unsafe-swiftshader WebGL fallback.
    ...(softwareGpu
      ? ["--use-gl=angle", "--use-angle=swiftshader"]
      : []),
    // Chromium 151 otherwise keeps a spare renderer resident beside the page
    // and Top Chrome WebUI renderers. Two is a soft ceiling: Chromium still
    // creates site-isolated renderers when security requires them, but it does
    // not retain an unused ~120 MiB process for a workload that already has a
    // warm persistent browser.
    "--renderer-process-limit=2",
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
