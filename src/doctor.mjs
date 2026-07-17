// Runtime resolution and readiness reporting shared by the CLI (`betterwright
// doctor`) and the MCP server's `browser_doctor` tool.
//
// The pinned versions here are the single Node-side source of truth;
// scripts/check-versions.mjs verifies them against package.json in CI.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  if (!dir)
    return {
      dir: null,
      version: null,
      binaryVersion: null,
      tier: null,
      binary: null,
      installed: false,
    };
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
    return {
      dir,
      version,
      binaryVersion: null,
      tier: null,
      binary: null,
      installed: false,
    };
  }
}

/** Build the readiness report `betterwright doctor` prints. */
export async function doctorReport() {
  const core = resolveCoreDir();
  const cloak = await cloakRuntime();
  let version = null;
  let chromium = null;
  if (core) {
    try {
      version = require(path.join(core, "package.json")).version;
    } catch {
      /* ignore */
    }
    try {
      chromium = require(path.join(core, "index.js")).chromium.executablePath();
    } catch {
      /* ignore */
    }
  }
  const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
  const report = {
    node: process.execPath,
    worker,
    worker_ok: fs.existsSync(worker),
    playwright_core: core,
    playwright_version: version,
    playwright_pinned: PINNED_PLAYWRIGHT_VERSION,
    cloakbrowser: cloak.dir,
    cloakbrowser_version: cloak.version,
    cloakbrowser_pinned: PINNED_CLOAKBROWSER_VERSION,
    cloakbrowser_binary_version: cloak.binaryVersion,
    cloakbrowser_binary_tier: cloak.tier,
    cloakbrowser_binary: cloak.binary,
    cloakbrowser_ok:
      cloak.version === PINNED_CLOAKBROWSER_VERSION && cloak.installed,
    chromium,
    chromium_ok: Boolean(chromium && fs.existsSync(chromium)),
  };
  const stealth = stealthDriverVersion();
  report.stealth_driver = stealth;
  report.stealth_available = Boolean(stealth);
  const backend = (process.env.BETTERWRIGHT_BROWSER || "cloak").trim().toLowerCase();
  report.browser = backend;
  report.ready =
    report.worker_ok &&
    version === PINNED_PLAYWRIGHT_VERSION &&
    (backend === "chromium" ? report.chromium_ok : report.cloakbrowser_ok);
  return report;
}
