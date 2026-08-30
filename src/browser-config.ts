// Persistent browser-provider settings: <home>/config.json, `browser` section.
//
// This is where `betterwright configure` writes and every launch reads. Two
// things live here:
//
//   - `default`: the provider a launch uses when nothing explicit was given —
//     the same shapes the `provider` option accepts (a named cloud provider,
//     a CDP endpoint, or a local Chromium binary), plus `keyEnv` so a config
//     can point at an environment variable instead of storing the key.
//   - `custom`: user-defined named providers. Each maps a name to a CDP
//     connect-URL template (`${apiKey}` is substituted at launch), so any
//     service that speaks CDP becomes `--browser <name>` without a
//     BetterWright release.
//
// Expansion happens on the client side, before the worker sees the option:
// the worker's resolveBrowserProvider stays a pure validator with no
// filesystem access. Precedence for one launch, first hit wins:
//
//   explicit `provider` option (CLI --browser included)
//   > BETTERWRIGHT_CDP_URL
//   > config `browser.default`
//   > the managed BetterChromium fork.
//
// The config file is written owner-only (writePrivate) because `default` and
// `custom` entries may carry API keys; `keyEnv` is the documented way to keep
// keys out of the file entirely.

import fs from "node:fs";
import path from "node:path";

import { BROWSER_PROVIDER_NAMES } from "./browser-providers.js";
import { writePrivate } from "./fs-private.js";
import { defaultHome } from "./home.js";
import {
  isRecord,
  isString,
  type UntrustedValue,
  untrustedEntries,
  untrustedField,
} from "./untrusted-value.js";

const CONFIG_FILE = "config.json";
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal token custom cdpUrl templates carry
const API_KEY_PLACEHOLDER = "${apiKey}";
// Lowercase, dash-separated, bounded: a custom name has to survive as a CLI
// flag value, a config key, and an error message.
const CUSTOM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Reserved by the provider layer: "cdp" labels an explicit-endpoint plan.
const RESERVED_NAMES = new Set(["cdp", "managed", "local", "none", "default"]);

/** A user-defined named provider: a CDP endpoint template plus key source. */
export interface CustomProviderDefinition {
  /** wss:// (or loopback ws://) connect URL; `${apiKey}` substituted at launch. */
  cdpUrl: string;
  /** Extra WebSocket headers; values may also carry `${apiKey}`. */
  headers?: Record<string, string>;
  /** Environment variable the API key is read from. */
  keyEnv?: string;
  /** API key stored in the config file (owner-only); prefer keyEnv. */
  apiKey?: string;
  /** Human label for menus and errors. */
  displayName?: string;
  /** Where the service documents its CDP endpoint. */
  docs?: string;
}

/**
 * The persisted default provider: the `provider` option shapes, plus
 * `keyEnv` so the key can live in the environment instead of the file.
 */
export interface DefaultBrowserRef {
  provider?: string;
  cdpUrl?: string;
  executablePath?: string;
  headers?: Record<string, string>;
  keyEnv?: string;
  apiKey?: string;
  sessionOptions?: Record<string, UntrustedValue>;
}

/** The sanitized `browser` section of <home>/config.json. */
export interface BrowserFileConfig {
  default?: DefaultBrowserRef;
  custom: Record<string, CustomProviderDefinition>;
}

export function browserConfigPath(home = defaultHome()) {
  return path.join(home, CONFIG_FILE);
}

function readConfigFile(home): UntrustedValue & object {
  try {
    const parsed: UntrustedValue = JSON.parse(
      fs.readFileSync(browserConfigPath(home), "utf8"),
    );
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {}; // missing or malformed config is simply "no defaults"
  }
}

function cleanString(value: UntrustedValue): string {
  return isString(value) ? value.trim() : "";
}

function cleanHeaders(value: UntrustedValue): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, entry] of untrustedEntries(value)) {
    const name = String(key || "").trim();
    if (name && isString(entry)) headers[name] = entry;
  }
  return Object.keys(headers).length ? headers : undefined;
}

function cleanCustomDefinition(value: UntrustedValue): CustomProviderDefinition | null {
  if (!isRecord(value)) return null;
  const cdpUrl = cleanString(untrustedField(value, "cdpUrl"));
  if (!cdpUrl) return null;
  const definition: CustomProviderDefinition = { cdpUrl };
  const headers = cleanHeaders(untrustedField(value, "headers"));
  if (headers) definition.headers = headers;
  const keyEnv = cleanString(untrustedField(value, "keyEnv"));
  if (keyEnv) definition.keyEnv = keyEnv;
  const apiKey = cleanString(untrustedField(value, "apiKey"));
  if (apiKey) definition.apiKey = apiKey;
  const displayName = cleanString(untrustedField(value, "displayName"));
  if (displayName) definition.displayName = displayName;
  const docs = cleanString(untrustedField(value, "docs"));
  if (docs) definition.docs = docs;
  return definition;
}

function cleanDefaultRef(value: UntrustedValue): DefaultBrowserRef | undefined {
  if (!isRecord(value)) return undefined;
  const ref: DefaultBrowserRef = {};
  const provider = cleanString(untrustedField(value, "provider"));
  if (provider) ref.provider = provider.toLowerCase();
  const cdpUrl = cleanString(untrustedField(value, "cdpUrl"));
  if (cdpUrl) ref.cdpUrl = cdpUrl;
  const executablePath = cleanString(untrustedField(value, "executablePath"));
  if (executablePath) ref.executablePath = executablePath;
  const headers = cleanHeaders(untrustedField(value, "headers"));
  if (headers) ref.headers = headers;
  const keyEnv = cleanString(untrustedField(value, "keyEnv"));
  if (keyEnv) ref.keyEnv = keyEnv;
  const apiKey = cleanString(untrustedField(value, "apiKey"));
  if (apiKey) ref.apiKey = apiKey;
  const sessionOptions = untrustedField(value, "sessionOptions");
  if (isRecord(sessionOptions)) {
    // SAFETY: isRecord confirmed a plain object; the values stay UntrustedValue
    // and pass to the provider's create-session request verbatim, unread here.
    ref.sessionOptions = sessionOptions as Record<string, UntrustedValue>;
  }
  // Exactly one kind, same rule the provider layer enforces; a ref that sets
  // none (or several) is a hand-edit gone wrong and reads as "no default".
  const kinds = [ref.provider, ref.cdpUrl, ref.executablePath].filter(Boolean).length;
  return kinds === 1 ? ref : undefined;
}

/**
 * Read the sanitized `browser` section of <home>/config.json. Unknown keys
 * and malformed entries are dropped so a typo can't smuggle unexpected
 * options into a launch.
 */
export function loadBrowserConfig(home = defaultHome()): BrowserFileConfig {
  const section = untrustedField(readConfigFile(home), "browser");
  const config: BrowserFileConfig = { custom: {} };
  if (!isRecord(section)) return config;
  const fallback = cleanDefaultRef(untrustedField(section, "default"));
  if (fallback) config.default = fallback;
  const custom = untrustedField(section, "custom");
  if (isRecord(custom)) {
    for (const [name, value] of untrustedEntries(custom)) {
      const key = String(name || "").trim().toLowerCase();
      const definition = cleanCustomDefinition(value);
      if (CUSTOM_NAME_PATTERN.test(key) && definition) config.custom[key] = definition;
    }
  }
  return config;
}

// Read-modify-write via Maps so unrelated config keys (and their order)
// survive without ever typing the untrusted file as a dictionary — the same
// discipline live-view-config.ts uses for its section.
function writeBrowserSection(home, mutate: (section: Map<string, UntrustedValue>) => void) {
  const config = readConfigFile(home);
  const existing = untrustedField(config, "browser");
  const section = new Map(isRecord(existing) ? untrustedEntries(existing) : []);
  mutate(section);
  const next = new Map(untrustedEntries(config));
  if (section.size) next.set("browser", Object.fromEntries(section));
  else next.delete("browser");
  fs.mkdirSync(home, { recursive: true });
  const file = browserConfigPath(home);
  writePrivate(file, `${JSON.stringify(Object.fromEntries(next), null, 2)}\n`);
  return file;
}

/**
 * Persist (or with null, clear) the default provider for this home.
 * Validates the ref the same way a launch will, so a bad choice fails here
 * with the command that made it rather than at the next launch.
 */
export function saveDefaultBrowser(ref: DefaultBrowserRef | null, home = defaultHome()) {
  if (ref != null) {
    const cleaned = cleanDefaultRef(ref);
    if (!cleaned) {
      throw new TypeError(
        "The default browser must set exactly one of provider, cdpUrl, or executablePath.",
      );
    }
    if (cleaned.provider && !BROWSER_PROVIDER_NAMES.includes(cleaned.provider)) {
      const custom = loadBrowserConfig(home).custom;
      if (!custom[cleaned.provider]) {
        throw new TypeError(
          `Unknown provider ${JSON.stringify(cleaned.provider)}. Built-in: ` +
            `${BROWSER_PROVIDER_NAMES.join(", ")}. Add a custom one first ` +
            "(betterwright configure).",
        );
      }
    }
    ref = cleaned;
  }
  return writeBrowserSection(home, (section) => {
    if (ref == null) section.delete("default");
    else section.set("default", ref);
  });
}

/** Validate and persist a custom named provider. */
export function saveCustomProvider(
  name: string,
  definition: CustomProviderDefinition,
  home = defaultHome(),
) {
  const key = String(name || "").trim().toLowerCase();
  if (!CUSTOM_NAME_PATTERN.test(key)) {
    throw new TypeError(
      "A custom provider name is 1-32 characters of lowercase letters, digits, and dashes.",
    );
  }
  if (BROWSER_PROVIDER_NAMES.includes(key) || RESERVED_NAMES.has(key)) {
    throw new TypeError(`${JSON.stringify(key)} is a built-in provider name; pick another.`);
  }
  const cleaned = cleanCustomDefinition(definition);
  if (!cleaned) {
    throw new TypeError("A custom provider needs a cdpUrl (wss:// connect URL).");
  }
  assertTemplateParses(cleaned.cdpUrl, key);
  return {
    name: key,
    file: writeBrowserSection(home, (section) => {
      const existing = untrustedField(Object.fromEntries(section), "custom");
      const custom = new Map(isRecord(existing) ? untrustedEntries(existing) : []);
      custom.set(key, cleaned);
      section.set("custom", Object.fromEntries(custom));
    }),
  };
}

/** Remove a custom provider; true when something was actually removed. */
export function removeCustomProvider(name: string, home = defaultHome()) {
  const key = String(name || "").trim().toLowerCase();
  let removed = false;
  writeBrowserSection(home, (section) => {
    const existing = untrustedField(Object.fromEntries(section), "custom");
    const custom = new Map(isRecord(existing) ? untrustedEntries(existing) : []);
    removed = custom.delete(key);
    if (custom.size) section.set("custom", Object.fromEntries(custom));
    else section.delete("custom");
  });
  return removed;
}

// A template must parse as a ws(s) URL once the key is substituted; checked
// at save time so `configure` rejects it with context instead of the next
// launch failing. The loopback-only rule for plaintext ws:// is enforced by
// the provider layer at launch, where it also covers hand-edited configs.
function assertTemplateParses(template: string, name: string) {
  const candidate = substituteApiKey(template, "placeholder-key");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError(`The ${name} cdpUrl is not a valid URL: ${template}`);
  }
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new TypeError(`The ${name} cdpUrl must be a ws:// or wss:// URL.`);
  }
}

// Literal substitution: provider keys are URL-safe tokens in practice, and a
// template author who needs percent-encoding can encode around the
// placeholder. The result is re-validated as a URL by the provider layer.
function substituteApiKey(template: string, apiKey: string) {
  return template.split(API_KEY_PLACEHOLDER).join(apiKey);
}

function resolveKey(choiceKey, definitionKeyEnv, definitionKey, env, what) {
  const key =
    cleanString(choiceKey) ||
    (definitionKeyEnv ? cleanString(env?.[definitionKeyEnv]) : "") ||
    cleanString(definitionKey);
  return { key, keyEnv: definitionKeyEnv, what };
}

/**
 * Expand a provider choice into the shapes the worker's
 * resolveBrowserProvider accepts, resolving custom names and keyEnv
 * indirection against this home's config. Built-in names, explicit CDP
 * endpoints, and local binaries pass through (with keyEnv resolved to an
 * apiKey when the ref carries one).
 *
 * Throws for a named provider that is neither built-in nor configured, and
 * for a custom provider whose template needs a key nobody supplied.
 */
export function expandProviderChoice(
  choice: UntrustedValue,
  { home = defaultHome(), env = process.env, config = null }: any = {},
) {
  if (choice == null || choice === false) return choice ?? null;
  if (isString(choice)) choice = { provider: choice };
  if (!isRecord(choice)) return choice; // let the provider layer report the type error
  const name = cleanString(untrustedField(choice, "provider")).toLowerCase();
  if (!name) return expandKeyEnv(choice, env);
  if (BROWSER_PROVIDER_NAMES.includes(name)) return expandKeyEnv(choice, env);

  const browserConfig: BrowserFileConfig = config ?? loadBrowserConfig(home);
  const definition = browserConfig.custom[name];
  if (!definition) {
    const custom = Object.keys(browserConfig.custom);
    throw new TypeError(
      `Unknown browser provider ${JSON.stringify(name)}. Built-in: ` +
        `${BROWSER_PROVIDER_NAMES.join(", ")}.` +
        (custom.length ? ` Configured: ${custom.join(", ")}.` : "") +
        " Add your own with `betterwright configure`, or pass { cdpUrl }.",
    );
  }
  const { key } = resolveKey(
    untrustedField(choice, "apiKey"),
    definition.keyEnv,
    definition.apiKey,
    env,
    name,
  );
  const template = definition.cdpUrl;
  const needsKey =
    template.includes(API_KEY_PLACEHOLDER) ||
    Object.values(definition.headers || {}).some((value) =>
      value.includes(API_KEY_PLACEHOLDER),
    );
  if (needsKey && !key) {
    throw new TypeError(
      `The ${definition.displayName || name} provider needs an API key: pass one, ` +
        (definition.keyEnv
          ? `set ${definition.keyEnv}, `
          : "") +
        "or re-run `betterwright configure`.",
    );
  }
  const cdpUrl = substituteApiKey(template, key);
  if (!definition.headers) return { cdpUrl };
  const headers: Record<string, string> = {};
  for (const [header, value] of Object.entries(definition.headers)) {
    headers[header] = substituteApiKey(value, key);
  }
  return { cdpUrl, headers };
}

// A built-in named ref may carry keyEnv (from a stored default); resolve it
// to an apiKey here because the provider layer only knows its own fixed env
// var. An explicit apiKey wins; strip keyEnv either way — the worker's
// validator does not know the field.
function expandKeyEnv(choice: UntrustedValue & object, env) {
  const keyEnv = cleanString(untrustedField(choice, "keyEnv"));
  if (!keyEnv) return choice;
  // SAFETY: the callers hold isRecord(choice); the spread only re-keys the
  // same untrusted fields so keyEnv can be dropped.
  const { keyEnv: _dropped, ...rest } = choice as Record<string, UntrustedValue>;
  const apiKey = cleanString(untrustedField(choice, "apiKey")) || cleanString(env?.[keyEnv]);
  if (!apiKey) {
    throw new TypeError(
      `The configured browser reads its API key from ${keyEnv}, which is not set. ` +
        "Set it, or re-run `betterwright configure`.",
    );
  }
  return { ...rest, apiKey };
}

/**
 * The persisted default provider for this home, expanded and ready for the
 * `provider` option — or null when the config names none and every launch
 * should use the managed fork.
 */
export function configuredDefaultProvider({
  home = defaultHome(),
  env = process.env,
}: any = {}) {
  const config = loadBrowserConfig(home);
  if (!config.default) return null;
  return expandProviderChoice(config.default, { home, env, config });
}
