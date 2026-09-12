import type {
  AskResult,
  BetterWrightOptions,
  CookieSyncOptions,
  CookieSyncResult,
  CredentialFillResult,
  FillCredentialOptions,
  GenerateAndFillCredentialOptions,
  HandoffResult,
  LiveViewChatMessage,
  LiveViewDrainChatResult,
  LiveViewOptions,
  LiveViewStatus,
  PendingCredentialListOptions,
  PendingCredentialListResult,
  PendingCredentialOptions,
  PendingCredentialResult,
  RunOptions,
  RunResult,
  WaitForAskOptions,
  WaitForHandoffOptions,
} from "./public.js";
import type { CredentialVault } from "./common.js";
import type { NetworkPolicy } from "./policy.js";
import type { UntrustedValue } from "./untrusted-value.js";
import type { VaultMatchMode } from "./vault.js";

/**
 * Thrown by `BetterWright` methods for lifecycle and configuration failures
 * (closed instance, invalid option combination, worker not running). Errors
 * inside a snippet instead come back in the `run()` envelope's `error` field.
 */
export class BrowserError extends Error {}

/** Narrow an untrusted value to a `VaultMatchMode`; throws on anything else. */
export function validateCredentialMatchMode(value: UntrustedValue): VaultMatchMode;

/**
 * A persistent, policy-guarded browser. Keep one instance alive for the whole
 * process; constructing one per call throws away the persistent session.
 * All browser work goes through `run()`, which executes async Playwright
 * JavaScript in the guarded worker and returns one result envelope. The
 * globals available inside a snippet (`page`, `snapshot`, `controls`,
 * `credentials`, `captcha`, `human`, `recording`, `webagents`, `webmcp`, and
 * friends) are documented in docs/browser-api.md.
 */
export class BetterWright {
  constructor(options?: BetterWrightOptions);

  /** State directory (`BETTERWRIGHT_HOME` or `~/.betterwright`). */
  home: string;
  /** The policy this browser enforces; `new NetworkPolicy()` when unset. */
  policy: NetworkPolicy;
  /** The active vault, or null when constructed with `vault: false`. */
  vault: CredentialVault | null;
  credentialCapture: boolean;
  browserFlavor: "chromium-fork";
  /** The configured provider, or null for the managed BetterChromium fork. */
  provider: import("./public.js").BrowserProviderOptions | null;
  /** Resolved headed/headless choice (`"auto"` has already been decided). */
  headless: boolean;
  /** Minimum gap between public-search navigations, when allowed. */
  searchMinIntervalMs: number;
  publicSearchPolicy: "block" | "allow";
  /** Ghostery ad/tracker blocking in effect. */
  adBlock: boolean;
  downloadPolicy: "ask" | "allow" | "deny";
  /** Whether snippets run in an isolated world via patchright-core. */
  stealthRuntimeFix: boolean;
  launchIdentity: boolean;
  fingerprintNoise: boolean;
  /** Egress proxy URL, or null for direct egress. */
  upstreamProxy: string | null;
  /** Whether locale/timezone resolve from the upstream egress IP. */
  geoip: boolean;
  locale: string | null;
  timezone: string | null;
  /** Whether the headed window is parked off-screen. */
  headedInvisible: boolean;
  /** Identity platform pin, or null for the real host OS. */
  platform: "macos" | "windows" | "linux" | null;
  /** Validated extra Chromium switches, from the option and the environment. */
  chromiumArgs: string[];
  /**
   * Explicit page-parking choice, or `undefined` to leave it to the worker
   * (which also reads `BETTERWRIGHT_PARK_BACKGROUND_PAGES` and never parks a
   * browser a human can see).
   */
  parkBackgroundPages: boolean | undefined;
  defaultTimeout: number;
  /**
   * Live-view defaults: constructor built-ins merged with `<home>/config.json`
   * and constructor options. `expose` is a plain string here because config
   * files are hand-editable; presets are validated when the viewer starts.
   */
  liveView: Omit<LiveViewOptions, "expose"> & { expose?: string };

  /**
   * Execute one snippet in the worker and return its result envelope.
   * `result` is the trailing expression or explicit `return`, JSON-summarized
   * (oversized output spills to a file as `SpilledRunOutput`). Calls within a
   * session are queued; different sessions may run concurrently. Never returns
   * stored secrets; a `pendingCredential` field carries secret-free recovery
   * metadata when a generated credential still needs a decision.
   */
  run<T = unknown>(code: string, options?: RunOptions): Promise<RunResult<T>>;
  /** Merge local browser cookies into this browser's persistent context. */
  syncCookies(options: CookieSyncOptions): Promise<CookieSyncResult>;
  /** Master-password protection and lock state for the vault. */
  vaultStatus(): Promise<{ available: boolean; configured?: boolean; locked?: boolean; osProtected?: boolean; exists?: boolean }>;
  /** Trusted host only. Never expose password input to a model tool. */
  unlockVault(options: { password: string }): Promise<{ configured: boolean; locked: boolean; osProtected: boolean }>;
  /** Revoke cached unlocks across every process sharing this home. */
  lockVault(): Promise<{ configured: boolean; locked: boolean; osProtected: boolean }>;
  /**
   * Close one session's pages and forget its state (tabs, `state`, cursor)
   * without touching the browser, the profile, or other sessions.
   */
  closeSession(
    session?: string,
  ): Promise<{ ok: boolean; closed: boolean; pagesClosed: number; error?: string }>;
  /** Start (or return the already-running) token-gated live-view server. */
  startLiveView(options?: LiveViewOptions): Promise<LiveViewStatus>;
  /** Stop the live-view server (no-op when not running). */
  stopLiveView(): Promise<LiveViewStatus>;
  /** Report live-view server state. */
  liveViewStatus(): Promise<LiveViewStatus>;
  /** Block until a human clicks Done/Cancel in the live viewer's handoff banner. */
  waitForHandoff(options?: WaitForHandoffOptions): Promise<HandoffResult>;
  /** Post a line into the live-view chat (agent steps / system notices). */
  liveViewPostChat(options?: {
    role?: "agent" | "you" | "system";
    text?: string;
    kind?: string;
  }): Promise<{ ok: boolean; message?: LiveViewChatMessage; error?: string }>;
  /**
   * Drain freeform human messages typed in the live-view chat since the last
   * drain (agent harness uses this between turns).
   */
  liveViewDrainChat(): Promise<LiveViewDrainChatResult>;
  /** Block until a human answers a question in the live-view chat. */
  waitForAsk(options?: WaitForAskOptions): Promise<AskResult>;
  /**
   * Fill a stored credential into the active page through trusted input; the
   * secret never enters model-authored code or the result. Call from trusted
   * host code, never expose to a model tool.
   */
  fillCredential(options?: FillCredentialOptions): Promise<CredentialFillResult>;
  /**
   * Generate a password, fill it, and stage it pending commit. The pending
   * secret is recoverable by `pendingId` until `commitGeneratedCredential` or
   * `discardGeneratedCredential` resolves it.
   */
  generateAndFillCredential(
    options?: GenerateAndFillCredentialOptions,
  ): Promise<CredentialFillResult>;
  /** Commit a staged generated credential after the signup is verified. */
  commitGeneratedCredential(
    options: PendingCredentialOptions,
  ): Promise<PendingCredentialResult>;
  /** Discard a staged generated credential the site rejected. */
  discardGeneratedCredential(
    options: PendingCredentialOptions,
  ): Promise<PendingCredentialResult>;
  /** Metadata for generated credentials still awaiting commit/discard. */
  listPendingCredentials(
    options?: PendingCredentialListOptions,
  ): Promise<PendingCredentialListResult>;
  /** Shut the worker down. Idempotent. */
  close(): Promise<void>;
}
