// BetterWright account credentials used by the optional managed live-view relay.
//
// Account secrets are intentionally separate from config.json so ordinary
// configuration inspection never prints them. The file is always written
// with owner-only permissions and the API key is never accepted as a normal
// command-line flag (which would leak through shell history and process lists).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ACCOUNT_FILE = "account.json";
const DEFAULT_RELAY_URL = "https://live.betterwright.com";
const API_KEY_PATTERN = /^bw_live_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/;

function defaultHome() {
  const configured = String(process.env.BETTERWRIGHT_HOME || "").trim();
  return configured || path.join(os.homedir(), ".betterwright");
}

export function accountConfigPath(home = defaultHome()) {
  return path.join(home, ACCOUNT_FILE);
}

export function normalizeRelayUrl(value = DEFAULT_RELAY_URL) {
  const raw = String(value || DEFAULT_RELAY_URL).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("BetterWright relay URL must be a valid https URL.");
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("BetterWright relay URL must use https (http is allowed only for loopback tests).");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("BetterWright relay URL cannot contain credentials, a query, or a fragment.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function isBetterWrightApiKey(value) {
  return API_KEY_PATTERN.test(String(value || "").trim());
}

export function maskBetterWrightApiKey(value) {
  const key = String(value || "").trim();
  const match = key.match(API_KEY_PATTERN);
  if (!match) return "not configured";
  return `bw_live_${match[1]}_${"•".repeat(8)}${match[2].slice(-4)}`;
}

export function loadAccountConfig(home = defaultHome()) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(accountConfigPath(home), "utf8"));
  } catch {
    parsed = {};
  }
  const fileKey = isBetterWrightApiKey(parsed?.apiKey) ? String(parsed.apiKey).trim() : "";
  const envKey = String(process.env.BETTERWRIGHT_API_KEY || "").trim();
  if (envKey && !isBetterWrightApiKey(envKey)) {
    throw new Error(
      "BETTERWRIGHT_API_KEY is not a valid BetterWright API key; refusing to fall back to a stored credential.",
    );
  }
  const apiKey = envKey || fileKey;
  // Invalid custom destinations must fail closed. Silently falling back to the
  // hosted relay could disclose a self-hosted key to the wrong service.
  const relayUrl = normalizeRelayUrl(
    process.env.BETTERWRIGHT_RELAY_URL || parsed?.relayUrl || DEFAULT_RELAY_URL,
  );
  return {
    ...(apiKey ? { apiKey } : {}),
    relayUrl,
    source: isBetterWrightApiKey(envKey) ? "environment" : fileKey ? "file" : "none",
  };
}

function writeAccount(config, home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = accountConfigPath(home);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on exotic filesystems */
  }
  return file;
}

export function saveAccountApiKey(apiKey, { home = defaultHome(), relayUrl } = {}) {
  const key = String(apiKey || "").trim();
  if (!isBetterWrightApiKey(key)) {
    throw new Error("That is not a BetterWright API key. Create one at https://betterwright.com/account.");
  }
  const current = loadAccountConfig(home);
  return writeAccount(
    {
      apiKey: key,
      relayUrl: normalizeRelayUrl(relayUrl || current.relayUrl || DEFAULT_RELAY_URL),
    },
    home,
  );
}

export function clearAccountConfig(home = defaultHome()) {
  const file = accountConfigPath(home);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* a missing file is already logged out */
  }
  return file;
}

export async function verifyBetterWrightApiKey(
  apiKey,
  { relayUrl = DEFAULT_RELAY_URL, timeoutMs = 10_000, fetchImpl = fetch } = {},
) {
  const key = String(apiKey || "").trim();
  if (!isBetterWrightApiKey(key)) {
    return { ok: false, error: "That is not a BetterWright API key." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || 0, 1_000));
  timer.unref?.();
  try {
    const response = await fetchImpl(`${normalizeRelayUrl(relayUrl)}/v1/cli/me`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      const relayMessage =
        typeof body?.error?.message === "string"
          ? body.error.message
          : typeof body?.error === "string"
            ? body.error
            : `BetterWright relay returned HTTP ${response.status}.`;
      return {
        ok: false,
        error:
          response.status === 401
            ? "The BetterWright API key was rejected. Create a new key and try again."
            : relayMessage,
      };
    }
    return { ok: true, ...body };
  } catch (error) {
    return {
      ok: false,
      error:
        error?.name === "AbortError"
          ? "Timed out while contacting the BetterWright relay."
          : `Could not contact the BetterWright relay: ${error?.message || error}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const BETTERWRIGHT_ACCOUNT_URL = "https://betterwright.com/account";
export const DEFAULT_BETTERWRIGHT_RELAY_URL = DEFAULT_RELAY_URL;
