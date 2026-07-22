// Runtime resolution and readiness reporting shared by the CLI (`betterwright
// doctor`) and the MCP server's `browser_doctor` tool.
//
// The pinned versions here are the single Node-side source of truth;
// scripts/check-versions.mjs verifies them against package.json in CI.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BETTERWRIGHT_CHROMIUM_VERSION,
  resolveChromiumForkBinary,
} from "./chromium-fork.mjs";
import { forkFontsDir } from "./fork-identity.mjs";

const require = createRequire(import.meta.url);

export const PINNED_PLAYWRIGHT_VERSION = "1.61.1";
export const PINNED_CLOAKBROWSER_VERSION = "0.4.10";

/** Version of the optional patchright-core stealth driver, or null if absent. */
export function stealthDriverVersion() {
  try {
    return require("patchright-core/package.json").version;
  } catch {
    return null;
  }
}

export function resolveCoreDir() {
  const override = (process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH || "").trim();
  if (override && fs.existsSync(path.join(override, "package.json"))) return override;
  try {
    return path.dirname(require.resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
}

export function resolveCloakDir() {
  const override = (process.env.BETTERWRIGHT_CLOAKBROWSER_PATH || "").trim();
  if (override && fs.existsSync(path.join(override, "package.json"))) return override;
  try {
    return path.resolve(
      path.dirname(fileURLToPath(import.meta.resolve("cloakbrowser"))),
      "..",
    );
  } catch {
    return null;
  }
}

export async function cloakRuntime() {
  const dir = resolveCloakDir();
  const noBinary = { binaryVersion: null, tier: null, binary: null, installed: false };
  if (!dir) return { dir: null, version: null, ...noBinary };
  let version = null;
  try {
    version = require(path.join(dir, "package.json")).version;
  } catch {
    /* reported below */
  }
  try {
    const cloak = await import(pathToFileURL(path.join(dir, "dist", "index.js")).href);
    const info = cloak.binaryInfo();
    return {
      dir,
      version,
      binaryVersion: info.version || null,
      tier: info.tier || null,
      binary: info.binaryPath,
      installed: Boolean(info.installed),
    };
  } catch {
    return { dir, version, ...noBinary };
  }
}

/** Build the readiness report `betterwright doctor` prints. */
export async function doctorReport() {
  const core = resolveCoreDir();
  const cloak = await cloakRuntime();
  let version = null;
  if (core) {
    try {
      version = require(path.join(core, "package.json")).version;
    } catch {
      /* ignore */
    }
  }
  const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
  const workerOk = fs.existsSync(worker);
  const cloakOk = cloak.version === PINNED_CLOAKBROWSER_VERSION && cloak.installed;
  const stealth = stealthDriverVersion();
  let chromiumFork = null;
  let chromiumForkError = null;
  try {
    chromiumFork = resolveChromiumForkBinary();
  } catch (error) {
    chromiumForkError = error instanceof Error ? error.message : String(error);
  }
  const browser = chromiumFork ? "chromium-fork" : "cloak";
  const chromiumForkFonts = chromiumFork ? forkFontsDir(chromiumFork) : null;
  const chromiumForkFontsWarning =
    chromiumFork && !chromiumForkFonts
      ? "fork binary has no fonts/ttf beside it; host fontconfig will leak (Linux tell). Deploy the macOS-metric font bundle next to chrome."
      : null;
  const ready =
    workerOk &&
    version === PINNED_PLAYWRIGHT_VERSION &&
    (chromiumFork ? true : cloakOk) &&
    !chromiumForkError;
  return {
    node: process.execPath,
    worker,
    worker_ok: workerOk,
    playwright_core: core,
    playwright_version: version,
    playwright_pinned: PINNED_PLAYWRIGHT_VERSION,
    cloakbrowser: cloak.dir,
    cloakbrowser_version: cloak.version,
    cloakbrowser_pinned: PINNED_CLOAKBROWSER_VERSION,
    cloakbrowser_binary_version: cloak.binaryVersion,
    cloakbrowser_binary_tier: cloak.tier,
    cloakbrowser_binary: cloak.binary,
    cloakbrowser_ok: cloakOk,
    chromium_fork: chromiumFork,
    chromium_fork_version: chromiumFork ? BETTERWRIGHT_CHROMIUM_VERSION : null,
    chromium_fork_error: chromiumForkError,
    chromium_fork_fonts: chromiumForkFonts,
    chromium_fork_fonts_warning: chromiumForkFontsWarning,
    stealth_driver: stealth,
    stealth_available: Boolean(stealth),
    browser,
    ready,
  };
}
