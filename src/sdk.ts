// The SDK entrypoint: the curated surface for driving BetterWright from your
// own code.
//
// The root export stays the compatibility surface and keeps everything it has
// ever exported, including internals a consumer rarely needs (CAPTCHA scoring,
// challenge detection, skill loading), so a reader cannot tell from it which
// exports are the supported ones. This file is that shorter list, plus
// `withBrowser` for the client lifetime every integration hand-writes.

import { BetterWright } from "./client.js";
import { isCallable, isRecord, type UntrustedValue } from "./untrusted-value.js";

export { resolveModel, resolveModelSelection, runAgentTask } from "./agent.js";
export {
  BROWSER_PROVIDER_NAMES,
  browserProviderInfo,
  createProviderSession,
  describeCdpUrl,
  getProviderSession,
  listProviderSessions,
  REST_BROWSER_PROVIDER_NAMES,
  stopProviderSession,
} from "./browser-providers.js";
export {
  BetterWright,
  BrowserError,
  validateCredentialMatchMode,
} from "./client.js";
export {
  listCookieSourceBrowsers,
  listCookieSourceProfiles,
} from "./cookie-sync.js";
export {
  METADATA_ADDRESSES,
  METADATA_HOSTNAMES,
  NetworkPolicy,
} from "./policy.js";
export { agentSystemPrompt } from "./prompt.js";
export {
  createLocalCredentialVault,
  LocalCredentialVault,
  LocalCredentialVaultError,
  VAULT_CATEGORIES,
  VAULT_MATCH_MODES,
} from "./vault.js";

/** What a caller hands to `withBrowser`: a function that takes the client. */
type BrowserCallback = (bw: BetterWright) => UntrustedValue;

/**
 * Narrow a caller-supplied value to the callback shape. The callback is
 * trusted host code, so unlike `UntrustedFunction` it is declared callable
 * with the client as its argument.
 */
function isBrowserCallback(value: UntrustedValue): value is BrowserCallback {
  return isCallable(value);
}

/**
 * Run `fn` against a client and close that client afterwards, including when
 * `fn` throws. Resolves with whatever `fn` returned.
 *
 * A client owns a worker process and a browser, so the close is the one step a
 * caller cannot skip, and every integration writes the same try/finally around
 * it. Also callable as `withBrowser(fn)` for the default options.
 */
export async function withBrowser(options, fn) {
  const shorthand = isCallable(options);
  const callback = shorthand ? options : fn;
  // Check the arguments before a client exists: a bad call must not leave a
  // worker process behind, and the message should name the fix.
  if (!isBrowserCallback(callback)) {
    throw new TypeError(
      "withBrowser expects a callback: withBrowser(fn) or withBrowser(options, fn).",
    );
  }
  if (!shorthand && options != null && !isRecord(options)) {
    throw new TypeError("withBrowser options must be an object.");
  }
  const bw = new BetterWright(shorthand ? {} : options || {});
  let failed = false;
  try {
    return await callback(bw);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // The callback's own error is the one worth reporting: a close failure
    // on top of it must not replace it. When the callback succeeded, a close
    // failure is the only thing wrong, and it does propagate.
    if (failed) await bw.close().catch(() => {});
    else await bw.close();
  }
}
