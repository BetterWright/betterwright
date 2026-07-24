// Persistent live-view settings: <home>/config.json, `liveView` section.
//
// This is where "set once, works everywhere" lives: the CLI, the library and
// the MCP server all merge these values under any explicit options. The
// password is stored as an unsalted SHA-256 digest ("sha256:<hex>") — it gates
// a screen-share viewer, not an account store, and the capability token in the
// URL remains the primary secret; the hash simply keeps the plaintext out of
// the config file, shell history and process listings. Set it with
// `betterwright view --set-password`.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_FILE = "config.json";
const PASSWORD_HASH_PATTERN = /^(sha256:)?[0-9a-f]{64}$/i;

function defaultHome() {
  const configured = (process.env.BETTERWRIGHT_HOME || "").trim();
  return configured || path.join(os.homedir(), ".betterwright");
}

export function liveViewConfigPath(home = defaultHome()) {
  return path.join(home, CONFIG_FILE);
}

/** "sha256:<hex>" digest for storing a live-view password at rest. */
export function hashLiveViewPassword(password) {
  return `sha256:${crypto.createHash("sha256").update(String(password)).digest("hex")}`;
}

export function isLiveViewPasswordHash(value) {
  return typeof value === "string" && PASSWORD_HASH_PATTERN.test(value.trim());
}

function readConfigFile(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(liveViewConfigPath(home), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // missing or malformed config is simply "no defaults"
  }
}

/**
 * Read the sanitized `liveView` section of <home>/config.json. Unknown keys
 * are dropped so a typo can't smuggle unexpected options into the server.
 */
export function loadLiveViewConfig(home = defaultHome()) {
  const section = readConfigFile(home).liveView;
  if (!section || typeof section !== "object" || Array.isArray(section)) return {};
  const out = {};
  if (typeof section.expose === "string" && section.expose.trim()) {
    out.expose = section.expose.trim().toLowerCase();
  }
  if (isLiveViewPasswordHash(section.passwordHash)) {
    out.passwordHash = section.passwordHash.trim().toLowerCase();
  }
  if (typeof section.password === "string" && section.password) {
    // Plaintext is accepted for hand-edited configs but hashed storage
    // (--set-password) is the documented path.
    out.password = section.password;
  }
  if (typeof section.host === "string" && section.host.trim()) out.host = section.host.trim();
  if (typeof section.publicHost === "string" && section.publicHost.trim()) {
    out.publicHost = section.publicHost.trim();
  }
  if (Number.isFinite(Number(section.port)) && Number(section.port) > 0) {
    out.port = Math.round(Number(section.port));
  }
  if (typeof section.interactive === "boolean") out.interactive = section.interactive;
  if (Number.isFinite(Number(section.quality))) out.quality = Number(section.quality);
  if (Number.isFinite(Number(section.maxWidth))) out.maxWidth = Number(section.maxWidth);
  return out;
}

/**
 * Set (password string) or clear (null) the stored live-view password hash.
 * Read-modify-write so unrelated config keys survive; the file is chmod 0600.
 */
export function saveLiveViewPassword(password, home = defaultHome()) {
  const config = readConfigFile(home);
  const section =
    config.liveView && typeof config.liveView === "object" && !Array.isArray(config.liveView)
      ? config.liveView
      : {};
  delete section.password; // never leave plaintext behind
  if (password == null || password === "") {
    delete section.passwordHash;
  } else {
    section.passwordHash = hashLiveViewPassword(password);
  }
  config.liveView = section;
  fs.mkdirSync(home, { recursive: true });
  const file = liveViewConfigPath(home);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // writeFileSync mode is ignored when the file exists
  } catch {
    /* best effort on exotic filesystems */
  }
  return file;
}
