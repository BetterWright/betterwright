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
import path from "node:path";

import { writePrivate } from "./fs-private.js";
import { defaultHome } from "./home.js";
import {
  isBoolean,
  isRecord,
  isString,
  type UntrustedValue,
  untrustedEntries,
  untrustedField,
} from "./untrusted-value.js";

const CONFIG_FILE = "config.json";
const PASSWORD_HASH_PATTERN = /^(sha256:)?[0-9a-f]{64}$/i;

/** The sanitized `liveView` section of <home>/config.json. */
export interface LiveViewFileConfig {
  expose?: string;
  passwordHash?: string;
  password?: string;
  host?: string;
  publicHost?: string;
  port?: number;
  interactive?: boolean;
  quality?: number;
  maxWidth?: number;
}

export function liveViewConfigPath(home = defaultHome()) {
  return path.join(home, CONFIG_FILE);
}

/** "sha256:<hex>" digest for storing a live-view password at rest. */
export function hashLiveViewPassword(password) {
  return `sha256:${crypto.createHash("sha256").update(String(password)).digest("hex")}`;
}

export function isLiveViewPasswordHash(value: UntrustedValue): value is string {
  return isString(value) && PASSWORD_HASH_PATTERN.test(value.trim());
}

function readConfigFile(home): UntrustedValue & object {
  try {
    const parsed: UntrustedValue = JSON.parse(
      fs.readFileSync(liveViewConfigPath(home), "utf8"),
    );
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {}; // missing or malformed config is simply "no defaults"
  }
}

/**
 * Read the sanitized `liveView` section of <home>/config.json. Unknown keys
 * are dropped so a typo can't smuggle unexpected options into the server.
 */
export function loadLiveViewConfig(home = defaultHome()): LiveViewFileConfig {
  const section = untrustedField(readConfigFile(home), "liveView");
  if (!isRecord(section)) return {};
  const out: LiveViewFileConfig = {};
  const expose = untrustedField(section, "expose");
  if (isString(expose) && expose.trim()) out.expose = expose.trim().toLowerCase();
  const passwordHash = untrustedField(section, "passwordHash");
  if (isLiveViewPasswordHash(passwordHash)) {
    out.passwordHash = passwordHash.trim().toLowerCase();
  }
  const password = untrustedField(section, "password");
  if (isString(password) && password) {
    // Plaintext is accepted for hand-edited configs but hashed storage
    // (--set-password) is the documented path.
    out.password = password;
  }
  const host = untrustedField(section, "host");
  if (isString(host) && host.trim()) out.host = host.trim();
  const publicHost = untrustedField(section, "publicHost");
  if (isString(publicHost) && publicHost.trim()) out.publicHost = publicHost.trim();
  const port = Number(untrustedField(section, "port"));
  if (Number.isFinite(port) && port > 0) out.port = Math.round(port);
  const interactive = untrustedField(section, "interactive");
  if (isBoolean(interactive)) out.interactive = interactive;
  const quality = Number(untrustedField(section, "quality"));
  if (Number.isFinite(quality)) out.quality = quality;
  const maxWidth = Number(untrustedField(section, "maxWidth"));
  if (Number.isFinite(maxWidth)) out.maxWidth = maxWidth;
  return out;
}

/**
 * Set (password string) or clear (null) the stored live-view password hash.
 * Read-modify-write so unrelated config keys survive; the file is chmod 0600.
 */
export function saveLiveViewPassword(password, home = defaultHome()) {
  const config = readConfigFile(home);
  const existing = untrustedField(config, "liveView");
  // Entries round-trip through Maps so unrelated keys (and their order)
  // survive without ever typing the untrusted config as a dictionary.
  const section = new Map(isRecord(existing) ? untrustedEntries(existing) : []);
  section.delete("password"); // never leave plaintext behind
  if (password == null || password === "") {
    section.delete("passwordHash");
  } else {
    section.set("passwordHash", hashLiveViewPassword(password));
  }
  const next = new Map(untrustedEntries(config));
  next.set("liveView", Object.fromEntries(section));
  fs.mkdirSync(home, { recursive: true });
  const file = liveViewConfigPath(home);
  writePrivate(file, `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`);
  return file;
}
