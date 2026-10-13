// Launch defaults are a closed set, shared by every host before construction.
import fs from "node:fs";
import path from "node:path";
import type { BetterWrightOptions } from "../types/public.js";
import { resolveAdBlock } from "./ad-block-config.js";
import { defaultHome } from "./home.js";
import { resolveProfileName } from "./profile-name.js";
import { isBoolean, isRecord, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

export type LaunchFileConfig = Pick<BetterWrightOptions,
  "headless" | "headedInvisible" | "profile" | "adBlock" | "locale" | "timezone" | "downloadPolicy">;

export function loadLaunchConfig(home = defaultHome()): LaunchFileConfig {
  let section: UntrustedValue;
  try {
    const parsed: UntrustedValue = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    section = untrustedField(parsed, "launch");
  } catch {
    return {};
  }
  if (!isRecord(section)) return {};
  const out: LaunchFileConfig = {};
  const headless = untrustedField(section, "headless");
  if (isBoolean(headless) || headless === "auto") out.headless = headless;
  const invisible = untrustedField(section, "headedInvisible");
  if (isBoolean(invisible)) out.headedInvisible = invisible;
  const adBlock = untrustedField(section, "adBlock");
  if (isBoolean(adBlock)) out.adBlock = adBlock;
  const profile = untrustedField(section, "profile");
  if (isString(profile) || profile === null) {
    try { out.profile = resolveProfileName(profile); } catch { /* Ignore invalid saved names. */ }
  }
  const policy = untrustedField(section, "downloadPolicy");
  if (policy === "ask" || policy === "allow" || policy === "deny") out.downloadPolicy = policy;
  const locale = untrustedField(section, "locale");
  if (isString(locale) && locale.trim()) {
    try { out.locale = Intl.getCanonicalLocales(locale.trim())[0]; } catch { /* Invalid locale. */ }
  }
  const timezone = untrustedField(section, "timezone");
  if (isString(timezone) && timezone.trim()) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone.trim() });
      out.timezone = timezone.trim();
    } catch { /* Invalid timezone. */ }
  }
  return out;
}

/** Environment overrides saved defaults; explicit host options come last. */
export function launchOptionsFromEnv(home = defaultHome(), env = process.env): LaunchFileConfig {
  const out = loadLaunchConfig(home);
  const headless = String(env.BETTERWRIGHT_HEADLESS || "").trim().toLowerCase();
  if (headless) {
    if (!["auto", "1", "true", "yes", "on", "0", "false", "no", "off"].includes(headless)) {
      throw new TypeError('BETTERWRIGHT_HEADLESS must be auto, true, or false.');
    }
    out.headless = headless === "auto" ? "auto" : ["1", "true", "yes", "on"].includes(headless);
    out.headedInvisible = false;
  }
  if (String(env.BETTERWRIGHT_AD_BLOCK || "").trim()) out.adBlock = resolveAdBlock(undefined, env);
  const profile = String(env.BETTERWRIGHT_PROFILE || "").trim();
  if (profile) out.profile = resolveProfileName(profile);
  const locale = String(env.BETTERWRIGHT_LOCALE || "").trim();
  if (locale) out.locale = locale;
  const timezone = String(env.BETTERWRIGHT_TIMEZONE || "").trim();
  if (timezone) out.timezone = timezone;
  const policy = String(env.BETTERWRIGHT_DOWNLOAD_POLICY || "").trim().toLowerCase();
  if (policy) {
    if (policy !== "ask" && policy !== "allow" && policy !== "deny") {
      throw new TypeError('BETTERWRIGHT_DOWNLOAD_POLICY must be "ask", "allow", or "deny".');
    }
    out.downloadPolicy = policy;
  }
  return out;
}

export function resolveLaunchOptions(options: BetterWrightOptions): BetterWrightOptions {
  // Lower-priority variables cannot reject a setting the caller supplied.
  const env = { ...process.env };
  if (options.headless !== undefined) delete env.BETTERWRIGHT_HEADLESS;
  if (options.adBlock !== undefined) delete env.BETTERWRIGHT_AD_BLOCK;
  if (options.profile !== undefined) delete env.BETTERWRIGHT_PROFILE;
  if (options.downloadPolicy !== undefined) delete env.BETTERWRIGHT_DOWNLOAD_POLICY;
  const defaults = launchOptionsFromEnv(options.home || defaultHome(), env);
  // A forced display mode must also cancel an inherited off-screen window.
  if (options.headless !== undefined && options.headedInvisible === undefined) defaults.headedInvisible = false;
  return { ...options, ...defaults, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
}
