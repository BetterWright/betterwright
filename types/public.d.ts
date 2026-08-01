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
  /**
   * Named persistent browser profile inside the home: a separate identity,
   * with its own cookie jar, its own profile lock, and its own session daemon,
   * at `browser/profiles/<name>`. Omit it (the default) to use the single
   * `browser/profile` directory, unchanged.
   *
   * This is a different axis from `session` names: sessions are concurrent
   * lanes inside one browser sharing one cookie jar (parallel work as the same
   * identity), profiles are separate cookie jars in separate browsers
   * (different accounts). Two profiles run at the same time, each fully logged
   * in; two instances of the *same* profile still serialize, and the second
   * gets an ephemeral signed-out profile. The vault, artifacts, and browser
   * binary cache stay shared across profiles.
   *
   * Names allow letters, digits, ".", "-", and "_", must start with a letter
   * or digit, and cannot contain path separators or "..". They are as
   * case-sensitive as the underlying filesystem. An invalid name throws a
   * `TypeError` at construction.
   */
  profile?: string;
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
   * Extra Chromium switches appended to the managed launch arguments, for
   * host-level tuning the managed list has no opinion on —
   * `["--disable-gpu", "--disable-software-rasterizer"]` on a GPU-less server
   * being the motivating case. Also settable per host with
   * `BETTERWRIGHT_CHROMIUM_ARGS` (whitespace-separated, quotes allowed); both
   * sources apply.
   *
   * Switches BetterWright owns are rejected with a `TypeError`: proxy
   * selection, remote debugging, the profile directory, and the
   * `--fingerprint*` / `--lang` / `--bw-timezone` / `--headless` identity
   * family. A switch that merely duplicates one already in the managed list is
   * dropped — Chromium resolves duplicates last-wins, so appending it would
   * override BetterWright's value rather than lose to it — and the drop is
   * reported in the next result's `warnings`.
   */
  chromiumArgs?: string[];
  /**
   * Quiet each session's pages between executions (default `true`).
   *
   * A headless Chromium target never becomes hidden — `document.visibilityState`
   * stays `"visible"` for the life of the page — so every open page keeps its
   * frame loop running at the host refresh rate whether or not anything is
   * driving it. Parking disables page script and pauses animation timelines
   * once a session's last execution unwinds, and restores both before the next
   * one begins, so the quiet window is exactly the model's thinking time.
   *
   * Never applies in headed mode or while a live view is streaming. The one
   * behavior change: a page animated by a `requestAnimationFrame` chain does
   * not resume that chain after being parked (CSS/Web Animations do). Also
   * settable per host with `BETTERWRIGHT_PARK_BACKGROUND_PAGES=0`.
   */
  parkBackgroundPages?: boolean;
  /**
   * Defaults for `startLiveView()`. Binds `0.0.0.0` with a LAN `publicHost` by
   * default so printed URLs open from another machine on the network. Pass
   * `{host:"127.0.0.1"}` for loopback-only.
   */
  liveView?: LiveViewOptions;
}

/** Options for the live-view server (constructor defaults and per-start overrides). */
export interface LiveViewOptions {
  /**
   * One-word hosting preset (overrides host/publicHost):
   * - "lan": bind all interfaces, print the LAN IP (default behavior)
   * - "local": loopback only — pair with your own tunnel (ssh, cloudflared, …)
   * - "tailscale": bind this machine's Tailscale address only
   */
  expose?: "lan" | "local" | "tailscale";
  /**
   * Require this password (min 4 chars) before the viewer loads, on top of the
   * URL capability token. Verified constant-time; grants a 12 h HttpOnly
   * session cookie. Failed attempts are rate-limited per source address.
   * Prefer persisting a hash in <home>/config.json via
   * `betterwright view --set-password` instead of passing plaintext here.
   */
  password?: string;
  /**
   * Stored password digest ("sha256:<64 hex>") — what
   * `betterwright view --set-password` writes to <home>/config.json.
   * Ignored when `password` is also set.
   */
  passwordHash?: string;
  /** Bind host (default "0.0.0.0"). */
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
  /** Hosting preset in effect ("lan", "local", or "tailscale"). */
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
