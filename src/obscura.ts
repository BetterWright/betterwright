import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OBSCURA_VERSION = "0.1.11";
export const OBSCURA_RELEASE_TAG = `v${OBSCURA_VERSION}`;
export const OBSCURA_REPOSITORY = "h4ckf0r0day/obscura";
export const OBSCURA_VERSION_MARKER = ".betterwright-version";

export const OBSCURA_PLATFORM_LAYOUT = Object.freeze({
  "darwin-arm64": path.join("darwin-arm64", "obscura"),
  "darwin-x64": path.join("darwin-x64", "obscura"),
  "linux-arm64": path.join("linux-arm64", "obscura"),
  "linux-x64": path.join("linux-x64", "obscura"),
  "win32-x64": path.join("win32-x64", "obscura.exe"),
});

/** SHA-256 pins for the official stealth-enabled v0.1.11 release archives. */
export const OBSCURA_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "obscura-aarch64-macos-stealth.tar.gz",
    sha256:
      "c134618e186d5266e9a0ee00a02739b37db07da2451648432b05e163908b1c7a",
  }),
  "darwin-x64": Object.freeze({
    name: "obscura-x86_64-macos-stealth.tar.gz",
    sha256:
      "2b9df54fcccfb000fdcdee0945759c789ee5594a5ba3146044a51ea24062cbb3",
  }),
  "linux-arm64": Object.freeze({
    name: "obscura-aarch64-linux-stealth.tar.gz",
    sha256:
      "d535324d44724cdfec16e500d0335903bca5c6a446e736b351691ee7e39debb4",
  }),
  "linux-x64": Object.freeze({
    name: "obscura-x86_64-linux-stealth.tar.gz",
    sha256:
      "00c823861606ef802338c817ebc11885fe670817170fa32f5d154ab9f5b8882c",
  }),
  "win32-x64": Object.freeze({
    name: "obscura-x86_64-windows-stealth.zip",
    sha256:
      "e42514179d3a478374dfaba4282b2414e07666a5e2d915c9c404beff0395f233",
  }),
});

function configuredValue(value) {
  return String(value || "").trim();
}

export function obscuraPlatformKey(
  platform = process.platform,
  arch = process.arch,
) {
  return `${platform}-${arch}`;
}

export function defaultObscuraRoot({ home = os.homedir() } = {}) {
  return path.join(home, ".betterwright", "obscura");
}

/**
 * Resolve the managed Obscura binary without changing BetterWright's client
 * surface. Explicit configuration is strict; an absent implicit install
 * returns null so an existing BetterWright installation can still start with
 * its Chromium compatibility backend until `betterwright setup` is run.
 */
export function resolveObscuraBinary({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const explicit = configuredValue(env.BETTERWRIGHT_OBSCURA_PATH);
  let root = configuredValue(env.BETTERWRIGHT_OBSCURA_ROOT);
  if (
    explicit.toLowerCase() === "off" ||
    root.toLowerCase() === "off"
  ) {
    return null;
  }

  const key = obscuraPlatformKey(platform, arch);
  const layout = OBSCURA_PLATFORM_LAYOUT[key];
  if (!layout) {
    if (explicit || root) {
      throw new Error(`No managed Obscura artifact for ${key}.`);
    }
    return null;
  }

  let implicit = false;
  if (!explicit && !root) {
    root = defaultObscuraRoot({ home });
    implicit = true;
  }

  let candidate;
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      throw new Error("BETTERWRIGHT_OBSCURA_PATH must be an absolute path.");
    }
    candidate = explicit;
  } else {
    if (!implicit && !path.isAbsolute(root)) {
      throw new Error("BETTERWRIGHT_OBSCURA_ROOT must be an absolute path.");
    }
    candidate = path.join(root, layout);
  }

  if (!existsSync(candidate)) {
    if (implicit) return null;
    throw new Error(`Obscura binary not found: ${candidate}`);
  }
  if (implicit) {
    const marker = path.join(path.dirname(candidate), OBSCURA_VERSION_MARKER);
    let installedVersion = "";
    try {
      installedVersion = String(readFileSync(marker, "utf8")).trim();
    } catch {
      return null;
    }
    if (installedVersion !== OBSCURA_VERSION) return null;
  }
  return candidate;
}
