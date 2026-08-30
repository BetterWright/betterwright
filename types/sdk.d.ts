// Hand-written declarations for the SDK entrypoint (see AGENTS.md). The
// provider helpers are declared here rather than re-exported because
// src/browser-providers.ts has no published declaration file of its own.

import type { BetterWright } from "./client.js";
import type { BetterWrightOptions, CloudBrowserProviderName } from "./public.js";

export { resolveModel, resolveModelSelection, runAgentTask } from "./agent.js";
export { BetterWright, BrowserError, validateCredentialMatchMode } from "./client.js";
export { METADATA_ADDRESSES, METADATA_HOSTNAMES, NetworkPolicy } from "./policy.js";
export { agentSystemPrompt } from "./prompt.js";
export {
  createLocalCredentialVault,
  LocalCredentialVault,
  LocalCredentialVaultError,
  VAULT_CATEGORIES,
  VAULT_MATCH_MODES,
} from "./vault.js";
export type * from "./public.js";

/** Names of the cloud browser providers `provider: { provider }` accepts. */
export const BROWSER_PROVIDER_NAMES: readonly CloudBrowserProviderName[];

export interface BrowserProviderInfo {
  name: string;
  docs: string;
  keyEnv: string;
}

/** Display name, docs URL, and API-key env var, or null for an unknown name. */
export function browserProviderInfo(name: string): BrowserProviderInfo | null;

/** A CDP URL with its credentials and key-like query values masked, for logs. */
export function describeCdpUrl(value: string): string;

/**
 * Run `fn` against a client and close that client afterwards, including when
 * `fn` throws. Resolves with whatever `fn` returned.
 */
export function withBrowser<T>(
  options: BetterWrightOptions,
  fn: (bw: BetterWright) => Promise<T>,
): Promise<T>;
export function withBrowser<T>(fn: (bw: BetterWright) => Promise<T>): Promise<T>;
