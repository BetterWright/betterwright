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
export type { ChromeCdpResult, EnsureChromeCdpOptions } from "./chrome.js";
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
  vault?: CredentialVault;
  browser?: BrowserFlavor;
  executablePath?: string;
  headless?: HeadlessMode;
  defaultTimeout?: number;
  connectOverCdp?: string;
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
