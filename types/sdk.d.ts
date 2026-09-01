// Hand-written declarations for the SDK entrypoint (see AGENTS.md). The
// provider helpers are declared here rather than re-exported because
// src/browser-providers.ts has no published declaration file of its own.

import type { BetterWright } from "./client.js";
import type { BetterWrightOptions, CloudBrowserProviderName } from "./public.js";
import type { UntrustedValue } from "./untrusted-value.js";

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

/** Built-in providers with create/list/get/stop session APIs. */
export const REST_BROWSER_PROVIDER_NAMES: readonly CloudBrowserProviderName[];

export type ProviderLifecycleKind = "rest" | "connect";

export interface BrowserProviderInfo {
  name: string;
  docs: string;
  keyEnv: string;
  /** `rest` providers expose start/list/stop; `connect` ones do not. */
  lifecycle: ProviderLifecycleKind;
}

/** Display name, docs URL, API-key env var, and lifecycle, or null. */
export function browserProviderInfo(name: string): BrowserProviderInfo | null;

/** A CDP URL with its credentials and key-like query values masked, for logs. */
export function describeCdpUrl(value: string): string;

/** One cloud browser session returned by create/list/get. */
export interface ProviderBox {
  provider: string;
  id: string;
  status: string;
  cdpUrl: string;
  liveViewUrl: string;
  endpointLabel: string;
}

export interface ProviderSessionRequest {
  apiKey?: string;
  sessionOptions?: Record<string, UntrustedValue>;
  status?: string;
}

export function createProviderSession(
  name: string,
  options?: ProviderSessionRequest,
): Promise<ProviderBox>;

export function listProviderSessions(
  name: string,
  options?: ProviderSessionRequest,
): Promise<ProviderBox[]>;

export function getProviderSession(
  name: string,
  id: string,
  options?: ProviderSessionRequest,
): Promise<ProviderBox>;

export function stopProviderSession(
  name: string,
  id: string,
  options?: ProviderSessionRequest,
): Promise<{ provider: string; id: string }>;

/**
 * Run `fn` against a client and close that client afterwards, including when
 * `fn` throws. Resolves with whatever `fn` returned.
 */
export function withBrowser<T>(
  options: BetterWrightOptions,
  fn: (bw: BetterWright) => Promise<T>,
): Promise<T>;
export function withBrowser<T>(fn: (bw: BetterWright) => Promise<T>): Promise<T>;
