// Browser provider resolution.
//
// BetterWright's default browser is always the managed BetterChromium fork,
// launched locally with every connection on the guard proxy. This module is
// the opt-in escape hatch: a provider may instead
//
//   1. launch a caller-supplied local Chromium binary (`executablePath`), or
//   2. connect over CDP to a remote browser — either a ready WebSocket
//      endpoint (`cdpUrl`), or a named cloud provider that mints one from its
//      REST API (`apiKey`).
//
// Named providers cover the mainstream cloud-browser services (Browser Use,
// Kernel, Browserbase, Steel, Anchor, Hyperbrowser, Browserless, Bright Data,
// Oxylabs); anything else that speaks plain CDP goes through `cdpUrl`.
//
// SECURITY BOUNDARY. A remote browser is outside the guard proxy — the
// network floor (SECURITY.md) cannot apply to a browser BetterWright did not
// launch, and the provider's control plane receives whatever API key the host
// configured. Both facts are surfaced as launch warnings, and provider
// credentials are redacted from every result envelope (they are registered as
// redaction secrets at launch).

import fs from "node:fs";
import path from "node:path";
import {
  isCallable,
  isRecord,
  isString,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";

const CDP_URL_ENV = "BETTERWRIGHT_CDP_URL";

// The worker's redaction registrar. Exported entrypoints double-check it at
// runtime because they are reachable from untyped call sites.
type SecretTracker = (secret: string) => void;

function isSecretTracker(value: UntrustedValue): value is SecretTracker {
  return isCallable(value);
}

// Register `value` and its URL-encoded form with the worker's redaction set,
// so an apiKey shows as [redacted] whether it appeared raw in a query string
// or inside a serialized URL.
function registerRedaction(trackSecret, value) {
  const secret = String(value || "");
  if (!secret || !isSecretTracker(trackSecret)) return;
  for (const candidate of new Set([secret, encodeURIComponent(secret)])) {
    try {
      trackSecret(candidate);
    } catch {
      /* redaction is best-effort; never block a launch */
    }
  }
}

// Turn `wss://host?apiKey=SECRET` into `wss://host?apiKey=***` for diagnostics.
export function describeCdpUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.username) url.username = "***";
    if (url.password) url.password = "***";
    // Snapshot the keys: `set` mutates the parameter list mid-iteration when a
    // key is duplicated (it drops the later occurrences).
    for (const key of Array.from(url.searchParams.keys())) {
      if (/key|token|auth|secret|password/i.test(key)) {
        url.searchParams.set(key, "***");
      }
    }
    return url.href;
  } catch {
    return String(value || "");
  }
}

function wssUrl(value, source) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new TypeError(`${source} must be a ws:// or wss:// URL.`);
  }
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new TypeError(
      `${source} must be a ws:// or wss:// URL; received ${JSON.stringify(url.protocol)}.`,
    );
  }
  // Plaintext CDP exposes browser state, cookies, page data, and endpoint
  // credentials to anyone on the path. It is only acceptable on loopback,
  // where the traffic never leaves the host; a remote endpoint must encrypt.
  if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
    throw new TypeError(
      `${source} must use wss:// for a remote endpoint; plaintext ws:// is ` +
        "only allowed on loopback (localhost/127.0.0.1/::1).",
    );
  }
  return url;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // WHATWG URL parses IPv4 to canonical dotted form and wraps IPv6 in
  // brackets, so these cover 127.x and the ::1 unspecified/loopback forms.
  return host.startsWith("127.") || host === "[::1]";
}

// Test seam: a fetchJson hook stands in for global fetch, receiving the same
// request and resolving with the parsed body, so tests never touch the network.
type FetchJsonHook = (
  url: string,
  request: { method: string; headers: Record<string, string>; body?: UntrustedValue },
) => Promise<UntrustedValue>;

function isFetchJsonHook(value: UntrustedValue): value is FetchJsonHook {
  return isCallable(value);
}

async function httpJson(fetchJson, method, url, { headers, body }) {
  if (isFetchJsonHook(fetchJson)) {
    return fetchJson(url, { method, headers, body });
  }
  const requestHeaders: Record<string, string> = {};
  if (body !== undefined) requestHeaders["content-type"] = "application/json";
  Object.assign(requestHeaders, headers);
  const init: RequestInit = { method, headers: requestHeaders };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(url, init);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* reported below as a non-JSON body */
  }
  if (!response.ok) {
    const detail =
      (isString(data?.error) && data.error) ||
      (isString(data?.message) && data.message) ||
      (isString(data?.error?.message) && data.error.message) ||
      text.slice(0, 200);
    throw new Error(
      `Cloud browser API ${method} ${url} failed with HTTP ${response.status}` +
        (detail ? `: ${detail}` : ""),
    );
  }
  if (data == null && text) {
    throw new Error(`Cloud browser API ${method} ${url} returned a non-JSON body.`);
  }
  return data;
}

function takeString(...candidates) {
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value) return value;
  }
  return "";
}

function requireStringField(value, what, provider) {
  const endpoint = takeString(value);
  if (!endpoint) {
    throw new Error(
      `The ${provider} create-browser response did not include ${what}.`,
    );
  }
  return endpoint;
}

// --- Named cloud providers --------------------------------------------------
//
// One descriptor per service: how to mint a CDP endpoint from an API key, and
// how to end the session when the browser closes. request.body receives the
// caller's `sessionOptions` verbatim so provider features (proxy country,
// region, keepAlive, profiles) pass through without a BetterWright release.

const PROVIDERS = Object.freeze({
  "browser-use": {
    displayName: "Browser Use",
    keyEnv: "BROWSER_USE_API_KEY",
    docs: "https://docs.browser-use.com/cloud",
    // The static connect URL mints a browser per connection and needs no
    // session bookkeeping, so no REST call is required.
    staticEndpoint({ apiKey, sessionOptions = {} }: any = {}) {
      const url = new URL("wss://connect.browser-use.com");
      url.searchParams.set("apiKey", apiKey);
      const country = takeString(
        sessionOptions.proxyCountryCode,
        sessionOptions.proxyCountry,
      );
      if (country) url.searchParams.set("proxyCountryCode", country);
      return url.href;
    },
  },
  kernel: {
    displayName: "Kernel",
    keyEnv: "KERNEL_API_KEY",
    docs: "https://www.kernel.sh/docs",
    request: {
      method: "POST",
      url: "https://api.onkernel.com/browsers",
      body: (sessionOptions) => sessionOptions,
    },
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    pick: (data) => takeString(data?.cdp_ws_url, data?.cdpWsUrl, data?.cdp_url),
    id: (data) => takeString(data?.session_id, data?.sessionId, data?.id),
    end: (id) => ({
      method: "DELETE",
      url: `https://api.onkernel.com/browsers/${encodeURIComponent(id)}`,
    }),
  },
  browserbase: {
    displayName: "Browserbase",
    keyEnv: "BROWSERBASE_API_KEY",
    docs: "https://docs.browserbase.com",
    request: {
      method: "POST",
      url: "https://api.browserbase.com/v1/sessions",
      body: (sessionOptions) => sessionOptions,
    },
    headers: (apiKey) => ({ "x-bb-api-key": apiKey }),
    pick: (data) => takeString(data?.connectUrl, data?.connect_url),
    id: (data) => takeString(data?.id),
    end: (id) => ({
      method: "POST",
      url: `https://api.browserbase.com/v1/sessions/${encodeURIComponent(id)}`,
      body: { status: "REQUEST_RELEASE" },
    }),
  },
  steel: {
    displayName: "Steel",
    keyEnv: "STEEL_API_KEY",
    docs: "https://docs.steel.dev",
    // Steel's connect URL alone starts a default session; sessionOptions may
    // pin an existing session id instead.
    staticEndpoint({ apiKey, sessionOptions = {} }: any = {}) {
      const url = new URL("wss://connect.steel.dev");
      url.searchParams.set("apiKey", apiKey);
      const sessionId = takeString(sessionOptions.sessionId);
      if (sessionId) url.searchParams.set("sessionId", sessionId);
      return url.href;
    },
  },
  anchor: {
    displayName: "Anchor Browser",
    keyEnv: "ANCHOR_API_KEY",
    docs: "https://docs.anchorbrowser.io",
    request: {
      method: "POST",
      url: "https://api.anchorbrowser.io/api/v1/sessions",
      body: (sessionOptions) => sessionOptions,
    },
    headers: (apiKey) => ({ "anchor-api-key": apiKey }),
    pick: (data) => takeString(data?.data?.cdp_url, data?.cdp_url),
    id: (data) => takeString(data?.data?.id, data?.id),
  },
  hyperbrowser: {
    displayName: "Hyperbrowser",
    keyEnv: "HYPERBROWSER_API_KEY",
    docs: "https://www.hyperbrowser.ai/docs",
    request: {
      method: "POST",
      url: "https://api.hyperbrowser.ai/api/session",
      body: (sessionOptions) => sessionOptions,
    },
    headers: (apiKey) => ({ "x-api-key": apiKey }),
    pick: (data) => takeString(data?.wsEndpoint, data?.ws_endpoint),
    id: (data) => takeString(data?.id, data?.sessionId),
    end: (id) => ({
      method: "POST",
      url: `https://api.hyperbrowser.ai/api/session/${encodeURIComponent(id)}/stop`,
    }),
  },
  browserless: {
    displayName: "Browserless",
    keyEnv: "BROWSERLESS_API_KEY",
    docs: "https://docs.browserless.io",
    staticEndpoint({ apiKey, sessionOptions = {} }: any = {}) {
      const url = new URL("wss://production-sfo.browserless.io/chromium");
      url.searchParams.set("token", apiKey);
      // Launch options are themselves query params (blockAds=true, …).
      for (const [key, value] of Object.entries(sessionOptions)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
      return url.href;
    },
  },
  brightdata: {
    displayName: "Bright Data",
    keyEnv: "BRIGHTDATA_BROWSER_AUTH",
    docs: "https://docs.brightdata.com/scraping-automation/scraping-browser",
    staticEndpoint({ apiKey }) {
      // The credential is `customer-zone:password` userinfo on the scraping
      // browser endpoint (port 9222 speaks CDP to Playwright/Puppeteer).
      const separator = apiKey.indexOf(":");
      if (separator <= 0) {
        throw new TypeError(
          'The brightdata apiKey must be the zone credential "brd-customer-…-zone-…:password".',
        );
      }
      const url = new URL("wss://brd.superproxy.io:9222");
      url.username = apiKey.slice(0, separator);
      url.password = apiKey.slice(separator + 1);
      return url.href;
    },
  },
  oxylabs: {
    displayName: "Oxylabs",
    keyEnv: "OXYLABS_BROWSER_AUTH",
    docs: "https://developers.oxylabs.io/products/headless-browser",
    staticEndpoint({ apiKey, sessionOptions = {} }: any = {}) {
      const separator = apiKey.indexOf(":");
      if (separator <= 0) {
        throw new TypeError(
          'The oxylabs apiKey must be the credential "USERNAME:PASSWORD".',
        );
      }
      const url = new URL("wss://ubc.oxylabs.io");
      url.username = apiKey.slice(0, separator);
      url.password = apiKey.slice(separator + 1);
      // p_cc=US, p_device=mobile, session_name=… ride the URL.
      for (const [key, value] of Object.entries(sessionOptions)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
      return url.href;
    },
  },
});

export const BROWSER_PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

export function browserProviderInfo(name) {
  const descriptor = PROVIDERS[String(name || "").trim().toLowerCase()];
  return descriptor
    ? { name: descriptor.displayName, docs: descriptor.docs, keyEnv: descriptor.keyEnv }
    : null;
}

/**
 * Resolve the browser provider for one launch, from the explicit option with
 * BETTERWRIGHT_CDP_URL as the host-level shorthand.
 *
 * A resolution is either synchronous (`plan`, already a CDP endpoint or local
 * binary) or session-minting (`create`, which makes the REST call at launch
 * time so a failed construction never leaves a billed session behind).
 */
export function resolveBrowserProvider(provider, { env = process.env } = {}) {
  if (provider == null || provider === false) {
    const shorthand = String(env?.[CDP_URL_ENV] || "").trim();
    return shorthand
      ? resolveBrowserProvider({ cdpUrl: shorthand }, { env })
      : null;
  }
  if (isString(provider)) provider = { provider };
  if (!isRecord(provider)) {
    throw new TypeError(
      "provider must be an object: { executablePath }, { cdpUrl }, or " +
        "{ provider: <name>, apiKey? }.",
    );
  }
  const executablePath = String(untrustedField(provider, "executablePath") || "").trim();
  const cdpUrl = String(untrustedField(provider, "cdpUrl") || "").trim();
  const name = String(untrustedField(provider, "provider") || "").trim().toLowerCase();
  const kinds = [executablePath, cdpUrl, name].filter(Boolean).length;
  if (kinds !== 1) {
    throw new TypeError(
      "provider sets exactly one of executablePath (a local Chromium binary), " +
        "cdpUrl (a CDP WebSocket endpoint), or provider (a cloud browser service).",
    );
  }
  if (executablePath) return { plan: resolveLocalProvider(executablePath) };
  if (cdpUrl) return { plan: resolveExplicitCdpProvider(cdpUrl, provider) };
  const descriptor = PROVIDERS[name];
  if (!descriptor) {
    throw new TypeError(
      `Unknown browser provider ${JSON.stringify(name)}. Supported: ` +
        `${BROWSER_PROVIDER_NAMES.join(", ")} — or pass { cdpUrl } for any ` +
        "CDP endpoint (docs: docs/browser-providers.md).",
    );
  }
  return { plan: resolveNamedProvider(descriptor, name, provider, env) };
}

function resolveLocalProvider(executablePath) {
  if (!path.isAbsolute(executablePath)) {
    throw new TypeError("provider.executablePath must be an absolute path.");
  }
  if (!fs.existsSync(executablePath)) {
    throw new TypeError(
      `provider.executablePath does not exist: ${executablePath}`,
    );
  }
  return {
    kind: "local",
    executablePath,
    warnings: [
      "Browser provider: a caller-supplied Chromium binary. The managed " +
        "BetterChromium identity patches are inactive — fingerprint and " +
        "headless parity depend on this build. Every connection still passes " +
        "through the local guard proxy.",
    ],
  };
}

function remoteWarnings(providerName, endsOnClose) {
  const warnings = [
    `Browser provider: ${providerName} — a remote browser, so page traffic ` +
      "does not pass through BetterWright's guard proxy and cannot be " +
      "network-policy enforced there. The browser-side network floor (the " +
      "SOCKS guard) only exists for locally launched browsers; model-side " +
      "boundaries (vault redaction, trusted credential filling, download " +
      "controls) still apply.",
  ];
  if (!endsOnClose) {
    warnings.push(
      `${providerName} sessions can keep running (and billing) after ` +
        "BetterWright disconnects; end the session from the provider's " +
        "console when the work is done.",
    );
  }
  return warnings;
}

function resolveExplicitCdpProvider(cdpUrl, provider) {
  const url = wssUrl(cdpUrl, "provider.cdpUrl");
  const headers = {};
  for (const [key, value] of Object.entries(provider.headers || {})) {
    const header = String(key || "").trim();
    if (!header) continue;
    if (!isString(value)) {
      throw new TypeError(`provider.headers[${JSON.stringify(header)}] must be a string.`);
    }
    headers[header] = value;
  }
  return {
    kind: "remote",
    provider: "cdp",
    cdpUrl: url.href,
    endpointLabel: describeCdpUrl(url),
    headers,
    apiKey: "",
    sessionId: "",
    end: null,
    warnings: remoteWarnings("a custom CDP endpoint", null),
  };
}

// Session options pass to the provider verbatim (including arrays — the
// descriptor's request decides what they mean), so unlike `isRecord` this
// only rules out non-objects.
function isSessionOptionsObject(value: UntrustedValue): value is object {
  return typeof value === "object" && value !== null;
}

function resolveNamedProvider(descriptor, name, provider, env) {
  const apiKey =
    takeString(provider.apiKey) || takeString(env?.[descriptor.keyEnv]);
  if (!apiKey) {
    throw new TypeError(
      `The ${descriptor.displayName} provider needs an API key: pass ` +
        `provider.apiKey or set ${descriptor.keyEnv}.`,
    );
  }
  const sessionOptions = isSessionOptionsObject(provider.sessionOptions)
    ? provider.sessionOptions
    : {};
  if (descriptor.request) {
    // Deferred: the session is minted when the browser actually launches, so
    // a failed client construction never leaves a billed session behind.
    return {
      kind: "remote",
      provider: name,
      apiKey,
      create: ({ fetchJson }: any = {}) =>
        createNamedSession(descriptor, name, apiKey, sessionOptions, fetchJson),
      warnings: remoteWarnings(descriptor.displayName, Boolean(descriptor.end)),
    };
  }
  const endpoint = wssUrl(
    descriptor.staticEndpoint({ apiKey, sessionOptions }),
    `the ${name} provider endpoint`,
  );
  return {
    kind: "remote",
    provider: name,
    apiKey,
    cdpUrl: endpoint.href,
    endpointLabel: describeCdpUrl(endpoint),
    headers: {},
    sessionId: "",
    end: null,
    warnings: remoteWarnings(descriptor.displayName, null),
  };
}

// A descriptor's request.body is either a literal payload or a builder fed
// the caller's sessionOptions.
function isSessionBodyBuilder(
  value: UntrustedValue,
): value is (sessionOptions: UntrustedValue) => UntrustedValue {
  return isCallable(value);
}

async function createNamedSession(descriptor, name, apiKey, sessionOptions, fetchJson) {
  const request = descriptor.request;
  const headers = descriptor.headers ? descriptor.headers(apiKey) : {};
  const body =
    isSessionBodyBuilder(request.body) ? request.body(sessionOptions) : request.body;
  const data = await httpJson(fetchJson, request.method, request.url, {
    headers,
    body,
  });
  const endpoint = wssUrl(
    requireStringField(descriptor.pick(data), "a CDP WebSocket URL", descriptor.displayName),
    `the ${name} CDP URL`,
  );
  const sessionId = descriptor.id ? takeString(descriptor.id(data)) : "";
  const end =
    descriptor.end && sessionId
      ? async () => {
          const stop = descriptor.end(sessionId);
          await httpJson(fetchJson, stop.method, stop.url, {
            headers,
            body: stop.body,
          });
        }
      : null;
  return {
    kind: "remote",
    provider: name,
    apiKey,
    cdpUrl: endpoint.href,
    endpointLabel: describeCdpUrl(endpoint),
    headers: {},
    sessionId,
    end,
    warnings: remoteWarnings(descriptor.displayName, Boolean(end)),
  };
}

/**
 * Attach redaction secrets for everything secret a provider plan holds: the
 * API key, any userinfo or credential params inside the endpoint, and header
 * credentials. Called by the worker at launch with its `trackSecret`.
 */
export function redactProviderSecrets(trackSecret, plan) {
  if (!plan) return;
  registerRedaction(trackSecret, plan.apiKey);
  if (plan.cdpUrl) {
    try {
      const url = new URL(plan.cdpUrl);
      registerRedaction(trackSecret, decodeURIComponent(url.username || ""));
      registerRedaction(trackSecret, decodeURIComponent(url.password || ""));
      for (const key of url.searchParams.keys()) {
        if (/key|token|auth|secret|password/i.test(key)) {
          registerRedaction(trackSecret, url.searchParams.get(key));
        }
      }
    } catch {
      /* diagnostics only */
    }
  }
  for (const value of Object.values(plan.headers || {})) {
    registerRedaction(trackSecret, String(value).replace(/^bearer\s+/i, ""));
  }
}
