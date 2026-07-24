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
  cloakV2?: boolean;
  upstreamProxy?: string;
  geoip?: boolean;
  locale?: string;
  timezone?: string;
  headedInvisible?: boolean;
  /**
   * Identity platform presented to sites. The native Chromium fork defaults
   * to "macos" — a realistic consumer-Mac fingerprint (UA, UA-CH,
   * navigator.platform, screen geometry) captured from genuine Chrome 150 on
   * an Apple-Silicon MacBook Pro. The managed CloakBrowser path defaults to
   * the host platform.
   */
  platform?: "macos" | "windows" | "linux";
  /**
   * Defaults for `startLiveView()`. The no-config default is loopback-only;
   * managed relay and direct LAN/Tailscale exposure are explicit choices.
   */
  liveView?: LiveViewOptions;
}

/** Options for the live-view server (constructor defaults and per-start overrides). */
export interface LiveViewOptions {
  /** Transport: direct self-hosting (default) or the account-backed relay. */
  transport?: "direct" | "relay";
  /**
   * Direct hosting preset (overrides host/publicHost):
   * - "local": loopback only (safe default)
   * - "lan": bind all interfaces and print the LAN IP
   * - "tailscale": bind this machine's Tailscale address only
   */
  expose?: "lan" | "local" | "tailscale";
  /**
   * Require this password (min 8 chars) before a direct viewer loads, on top
   * of the URL capability token. Verified constant-time; grants a 12 h
   * HttpOnly session cookie. Failed attempts are rate-limited per source.
   * Managed relay links use their fragment capability instead. Prefer
   * persisting a hash via `betterwright view --set-password`.
   */
  password?: string;
  /**
   * Stored password verifier. New values use salted scrypt; legacy
   * `sha256:<64 hex>` values remain accepted for upgrade compatibility.
   * Ignored when `password` is also set and applies only to direct mode.
   */
  passwordHash?: string;
  /** Bind host for direct mode (default "127.0.0.1"). */
  host?: string;
  /** Bind port (default 0 = ephemeral). */
  port?: number;
  /** Allow viewers to control the browser outside handoffs (default true). */
  interactive?: boolean;
  /** JPEG screencast quality 10–90 (default 60). */
  quality?: number;
  /** Screencast max frame dimension in px (default 1440). */
  maxWidth?: number;
  /** Host to print in the URL when binding a wildcard address (default: LAN IP). */
  publicHost?: string;
  /** Which session's current tab streams first (default "default"). */
  session?: string;
  /** Managed-relay endpoint override, primarily for self-hosting/tests. */
  relayUrl?: string;
  /**
   * BetterWright personal API key for managed relay. Prefer
   * `BETTERWRIGHT_API_KEY` or `betterwright account set-key` over source code.
   */
  apiKey?: string;
}

/** Result of `startLiveView()` / `liveViewStatus()`. */
export interface LiveViewStatus {
  ok: boolean;
  running?: boolean;
  /** Capability URL (embeds the token — treat it like a password). */
  url?: string;
  host?: string;
  port?: number;
  token?: string;
  /** Transport in effect. */
  transport?: "direct" | "relay";
  /** Hosting preset in effect (including "relay" for managed links). */
  expose?: string;
  /** True when a password gate is active. */
  passwordProtected?: boolean;
  interactive?: boolean;
  viewers?: number;
  agent?: "idle" | "driving" | "handoff";
  handoff?: { active: boolean; prompt?: string };
  ask?: { active: boolean; question?: string; options?: string[] };
  /** Count of freeform human chat messages waiting for the agent to drain. */
  pendingChat?: number;
  /** Daemon session immutably bound to this capability. */
  session?: string;
  /** Opaque managed relay session ID. */
  sessionId?: string;
  /** Managed-relay allowance state. */
  quota?: {
    limitSeconds?: number;
    usedSeconds?: number;
    remainingSeconds?: number;
    startsAt?: string;
    endsAt?: string;
    resetAt?: string;
  } | null;
  /** Managed relay session expiry. */
  expiresAt?: string | null;
  /** True when start() found the server already running (URL unchanged). */
  alreadyRunning?: boolean;
  error?: string;
}

/** Result of `waitForHandoff()`. */
export interface HandoffResult {
  ok: boolean;
  /** How the handoff ended: the viewer's Done/Cancel button, or the timeout. */
  action?: "done" | "cancel" | "timeout";
  /** The human's optional note back to the caller. */
  note?: string;
  error?: string;
}

/** Options for `waitForHandoff()`. */
export interface WaitForHandoffOptions {
  session?: string;
  /** Shown to the human in the viewer's handoff banner. */
  prompt?: string;
  /** Hard bound in seconds (default 1800). */
  timeout?: number;
}

/** A line in the live-view chat (agent steps or human guidance). */
export interface LiveViewChatMessage {
  id?: number;
  role?: "agent" | "you" | "system";
  text: string;
  kind?: string;
  at?: number;
}

/** Result of `liveViewDrainChat()`. */
export interface LiveViewDrainChatResult {
  ok: boolean;
  messages?: Array<{ text: string; at?: number }>;
  error?: string;
}

/** Result of `waitForAsk()`. */
export interface AskResult {
  ok: boolean;
  /** How the ask ended: a chat answer, cancel (view stopped), or timeout. */
  action?: "answer" | "cancel" | "timeout";
  /** The human's typed (or chip-selected) answer. */
  answer?: string;
  error?: string;
}

/** Options for `waitForAsk()`. */
export interface WaitForAskOptions {
  session?: string;
  /** Question shown in the live-view chat. */
  question?: string;
  /** Optional short choices rendered as chips. */
  options?: string[];
  /** Hard bound in seconds (default 1800). */
  timeout?: number;
}
