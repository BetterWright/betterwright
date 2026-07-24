// Persistent live-view settings: <home>/config.json, `liveView` section.
//
// This is where "set once, works everywhere" lives: the CLI, the library and
// the MCP server all merge these values under any explicit options. The
// New passwords are stored with a random salt and scrypt. Legacy
// "sha256:<hex>" values remain readable for downgrade/upgrade compatibility,
// but saveLiveViewPassword always writes the stronger format. The capability
// token in the URL remains the primary direct-view secret. Set the optional
// extra gate with `betterwright view --set-password`.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_FILE = "config.json";
const LEGACY_PASSWORD_HASH_PATTERN = /^(sha256:)?[0-9a-f]{64}$/i;
const SCRYPT_PASSWORD_HASH_PATTERN =
  /^scrypt:16384:8:1:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$/;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function defaultHome() {
  const configured = (process.env.BETTERWRIGHT_HOME || "").trim();
  return configured || path.join(os.homedir(), ".betterwright");
}

export function liveViewConfigPath(home = defaultHome()) {
  return path.join(home, CONFIG_FILE);
}

/** Salted scrypt digest for storing a direct live-view password at rest. */
export function hashLiveViewPassword(password, salt = crypto.randomBytes(16)) {
  const saltBytes = Buffer.from(salt);
  if (saltBytes.length !== 16) throw new Error("Live-view password salt must be 16 bytes.");
  const digest = crypto.scryptSync(String(password), saltBytes, 32, SCRYPT_OPTIONS);
  return `scrypt:16384:8:1:${saltBytes.toString("base64url")}:${digest.toString("base64url")}`;
}

export function isLiveViewPasswordHash(value) {
  if (typeof value !== "string") return false;
  const hash = value.trim();
  return SCRYPT_PASSWORD_HASH_PATTERN.test(hash) || LEGACY_PASSWORD_HASH_PATTERN.test(hash);
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
  if (typeof section.transport === "string" && section.transport.trim()) {
    const transport = section.transport.trim().toLowerCase();
    if (["direct", "relay"].includes(transport)) out.transport = transport;
  }
  if (isLiveViewPasswordHash(section.passwordHash)) {
    out.passwordHash = section.passwordHash.trim();
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
 * Persist sanitized live-view mode settings without disturbing unrelated
 * config keys. `transport: "relay"` always keeps the local origin loopback;
 * direct modes use the explicit expose preset selected by the user.
 */
export function saveLiveViewSettings(settings = {}, home = defaultHome()) {
  const config = readConfigFile(home);
  const section =
    config.liveView && typeof config.liveView === "object" && !Array.isArray(config.liveView)
      ? config.liveView
      : {};
  if (settings.transport != null) {
    const transport = String(settings.transport).trim().toLowerCase();
    if (!["direct", "relay"].includes(transport)) {
      throw new Error('liveView.transport must be "direct" or "relay".');
    }
    section.transport = transport;
  }
  if (settings.expose != null) {
    const expose = String(settings.expose).trim().toLowerCase();
    if (!["local", "lan", "tailscale"].includes(expose)) {
      throw new Error('liveView.expose must be "local", "lan", or "tailscale".');
    }
    section.expose = expose;
  }
  config.liveView = section;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = liveViewConfigPath(home);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on exotic filesystems */
  }
  return file;
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
