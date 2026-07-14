import path from "node:path";
import { pathToFileURL } from "node:url";

let cloakModulePromise = null;

function isFreeDarwinV145(binaryInfo) {
  return (
    binaryInfo?.tier === "free" &&
    String(binaryInfo?.platform || "").startsWith("darwin-") &&
    String(binaryInfo?.version || "").startsWith("145.")
  );
}

function isFreeLinuxV146(binaryInfo) {
  return (
    binaryInfo?.tier === "free" &&
    String(binaryInfo?.platform || "").startsWith("linux-") &&
    String(binaryInfo?.version || "").startsWith("146.")
  );
}

/** Keep known Cloak/X11 viewport combinations coherent and non-zero. */
export function managedCloakViewport(binaryInfo, headless) {
  if (headless && isFreeDarwinV145(binaryInfo)) {
    return { width: 1438, height: 679 };
  }
  if (!headless && isFreeLinuxV146(binaryInfo)) {
    return { width: 1365, height: 900 };
  }
  return undefined;
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
      const wrapped = new Error(
        "CloakBrowser is the managed BetterWright browser but its wrapper is not " +
          "available. Run `betterwright setup`, or explicitly select the degraded " +
          "Chromium backend.",
      );
      wrapped.cause = error;
      throw wrapped;
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
