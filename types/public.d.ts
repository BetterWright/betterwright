import type { NetworkPolicy } from "./policy.js";
import type {
  BrowserFlavor,
  CredentialVault,
  DownloadPolicy,
  HeadlessMode,
  PublicSearchPolicy,
} from "./common.js";

export * from "./common.js";
export type {
  NetworkDecision,
  NetworkPolicyCustom,
  NetworkPolicyOptions,
  NetworkRequestDetails,
} from "./policy.js";
export type { Guardrails } from "./prompt.js";
export type {
  BetterWrightArtifactLike,
  BetterWrightResultLike,
  PiImageArtifact,
  PiImageContentBlock,
  PiImageContentOptions,
} from "./pi.js";

export interface BetterWrightOptions {
  home?: string;
  policy?: NetworkPolicy;
  /** Custom credential backend, or false/null to disable the built-in vault. */
  vault?: CredentialVault | false | null;
  /**
   * Capture accepted logins in the browser: logins the model types are saved
   * silently; logins the user types manually prompt in headed sessions.
   * Defaults to true when a vault is active; forced off with `vault: false`.
   */
  credentialCapture?: boolean;
  browser?: BrowserFlavor;
  headless?: HeadlessMode;
  defaultTimeout?: number;
  searchMinIntervalMs?: number;
  publicSearchPolicy?: PublicSearchPolicy;
  downloadPolicy?: DownloadPolicy;
  /**
   * Run model snippets in an isolated world (via the optional `patchright-core`
   * driver) so `page.evaluate` no longer trips main-world automation detection.
   * Trade-off: snippets cannot read page-defined main-world globals. Off by
   * default. Also settable with `BETTERWRIGHT_STEALTH_RUNTIME_FIX=1`.
   */
  stealthRuntimeFix?: boolean;
}
