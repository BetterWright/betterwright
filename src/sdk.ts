// The SDK entrypoint: the curated surface for driving BetterWright from your
// own code.
//
// The root export stays the compatibility surface and keeps everything it has
// ever exported, including internals a consumer rarely needs (CAPTCHA scoring,
// challenge detection, skill loading), so a reader cannot tell from it which
// exports are the supported ones. This file is that shorter list, plus
// `withBrowser` for the client lifetime every integration hand-writes.

import { BetterWright } from "./client.js";
import { isCallable } from "./untrusted-value.js";

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
  const bw = new BetterWright(shorthand ? {} : options);
  try {
    return await callback(bw);
  } finally {
    await bw.close();
  }
}
