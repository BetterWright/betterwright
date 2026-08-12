// The Node client for BetterWright.
//
// It owns one long-lived worker process, answers the worker's `guard` (network
// policy) and `vault` (credential) RPCs, and exposes `run()` for executing
// Playwright snippets.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
// The published declarations are hand-written (see AGENTS.md). Typing the
// implementation against them turns a drift between the two into a compile
// error instead of something only a consumer would notice.
import type { BetterWrightOptions } from "../types/public.js";
import { resolveChromiumArgs } from "./chromium-args.js";
import {
  assertRotationPreservesMatchMode,
  MAX_PENDING_CREDENTIAL_ORIGINS,
  pendingCredentialRecovery,
  validateCredentialMatchMode,
} from "./credential-constants.js";
import { normalizeDownloadPolicy } from "./downloads.js";
import { defaultHome } from "./home.js";
import { defaultLiveViewListen } from "./live-view.js";
import { loadLiveViewConfig } from "./live-view-config.js";
import { NetworkPolicy } from "./policy.js";
import { profileDirFor, resolveProfileName } from "./profile-name.js";
import { listSkills, skillHintsForPages } from "./skills.js";
import { createLocalCredentialVault } from "./vault.js";

const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url));
// The lane host-wide calls (live view, worker revival) queue on. A session can
// never collide with it: session names are trimmed strings, and this is not.
const HOST_LANE = Symbol("betterwright-host-lane");
const DEFAULT_TIMEOUT_SECONDS = 30;
const WORKER_START_TIMEOUT_MS = 15_000;
const WORKER_RPC_DRAIN_TIMEOUT_MS = 250;
const PENDING_CREDENTIAL_FINALIZE_ACTIONS = new Set(["commit", "discard"]);
const DEFINITIVE_GENERATE_FAILURE_CODES = new Set([
  "BAD_ACTION",
  "BAD_INPUT",
  "BAD_ORIGIN",
  "NOT_FOUND",
  "PENDING_CONFLICT",
  "UNSAFE_PATH",
  "VAULT_AUTH_FAILED",
  "VAULT_CORRUPT",
  "VAULT_KEY_INVALID",
  "VAULT_KEY_MISSING",
  "VAULT_LOCK_TIMEOUT",
  "VAULT_SECRET_CAPACITY",
  "VAULT_TOO_LARGE",
]);

export { validateCredentialMatchMode };

export class BrowserError extends Error {}

/** Best-effort detection of a graphical display, for headless: "auto". */
export function displayAvailable() {
  const forced = (process.env.BETTERWRIGHT_DISPLAY || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(forced)) return true;
  if (["0", "false", "no", "off"].includes(forced)) return false;
  if (process.platform === "darwin")
    return !(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  if (process.platform === "win32")
    return (process.env.SESSIONNAME || "").trim().toLowerCase() !== "services";
  return Boolean(
    (process.env.DISPLAY || "").trim() || (process.env.WAYLAND_DISPLAY || "").trim(),
  );
}

function resolveHeadless(headless) {
  if (headless === "auto" || headless === undefined) return !displayAvailable();
  return headless !== false;
}

function assertManagedCloakOnly(options) {
  const browser = String(
    options.browser ?? process.env.BETTERWRIGHT_BROWSER ?? "cloak",
  )
    .trim()
    .toLowerCase();
  if (browser !== "cloak") {
    throw new TypeError(
      'BetterWright only supports the managed BetterWright browser backend; browser must be "cloak".',
    );
  }
  if (String(options.executablePath || "").trim()) {
    throw new TypeError(
      "executablePath is not supported. Use BETTERWRIGHT_CHROMIUM_PATH / " +
        "BETTERWRIGHT_CHROMIUM_ROOT for the native fork, or " +
        "CLOAKBROWSER_BINARY_PATH for an official CloakBrowser binary.",
    );
  }
  const cdp = String(
    options.connectOverCdp ?? process.env.BETTERWRIGHT_CONNECT_OVER_CDP ?? "",
  ).trim();
  if (cdp) {
    throw new TypeError(
      "connectOverCdp is not supported because BetterWright only launches its managed CloakBrowser.",
    );
  }
}

function resolvePublicSearchPolicy(policy): "block" | "allow" {
  const value = String(
    policy ?? process.env.BETTERWRIGHT_PUBLIC_SEARCH_POLICY ?? "allow",
  )
    .trim()
    .toLowerCase();
  if (!["block", "allow"].includes(value)) {
    throw new TypeError('publicSearchPolicy must be "block" or "allow".');
  }
  return value as "block" | "allow";
}

/** Translate host-facing fillCredential options into the worker `spec`. */
function buildFillSpec(options) {
  const fields: Record<string, any> = {};
  for (const key of [
    "passwordSelector",
    "currentPasswordSelector",
    "usernameSelector",
    "confirmPasswordSelector",
    "submitSelector",
  ]) {
    const value = String(options[key] ?? "").trim();
    if (value) fields[key] = value;
  }
  if (options.submit === true) fields.submit = true;
  if (options.generate) {
    assertRotationPreservesMatchMode(options);
    const generate: Record<string, any> = {};
    if (options.id != null) generate.id = options.id;
    if (options.username != null) generate.username = options.username;
    if (Object.hasOwn(options, "label")) generate.label = options.label;
    if (options.length != null) generate.length = options.length;
    if (typeof options.includeSymbols === "boolean")
      generate.includeSymbols = options.includeSymbols;
    if (options.matchMode !== undefined)
      generate.matchMode = validateCredentialMatchMode(options.matchMode);
    return {
      action: "generate",
      fields,
      generate,
    };
  }
  return {
    action: "fill",
    fields,
    record: { id: options.id, username: options.username },
  };
}

function resolvePlaywrightCore() {
  const override = (process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH || "").trim();
  if (override) return override;
  // A sibling node_modules (normal npm install) is resolved by the worker's
  // own bare `import "playwright-core"`, so returning "" is correct there.
  return "";
}

const STEALTH_REGISTER_URL = new URL("./stealth-register.js", import.meta.url).href;

/**
 * Resolve the opt-in Runtime.enable stealth fix. Precedence: an explicit
 * option > the `BETTERWRIGHT_STEALTH_RUNTIME_FIX` env override > off.
 * When on, the worker process is spawned with a module-resolution hook that
 * redirects `playwright-core` to the pre-patched `patchright-core` drop-in, so
 * every `page.evaluate` runs in an isolated world (defeating main-world
 * automation detection) instead of the page's main world. It applies to the
 * managed Cloak browser too, because the hook intercepts the wrapper's own
 * `import("playwright-core")`. Cost: model snippets can no longer read
 * page-defined main-world globals (e.g. `window.__NEXT_DATA__`); DOM access is
 * unaffected. Off by default so normal runs keep full main-world access.
 */
function resolveStealthRuntimeFix(value) {
  const raw = value ?? process.env.BETTERWRIGHT_STEALTH_RUNTIME_FIX;
  if (raw == null) return false;
  if (typeof raw === "boolean") return raw;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/** Confirm the pre-patched driver is installed before enabling stealth. */
function stealthDriverAvailable() {
  const require = createRequire(import.meta.url);
  try {
    require.resolve("patchright-core");
    return true;
  } catch {
    return false;
  }
}

/** A persistent, policy-guarded Playwright browser. */
export class BetterWright {
  declare home: string;
  declare profile: string | null;
  declare policy: NetworkPolicy;
  declare vault: any;
  declare credentialCapture: boolean;
  declare browserFlavor: "cloak";
  declare headless: boolean;
  declare searchMinIntervalMs: number;
  declare publicSearchPolicy: "block" | "allow";
  declare downloadPolicy: "ask" | "allow" | "deny";
  declare stealthRuntimeFix: boolean;
  declare cloakV2: boolean;
  declare upstreamProxy: string | null;
  declare geoip: boolean;
  declare locale: string | null;
  declare timezone: string | null;
  declare headedInvisible: boolean;
  declare chromiumArgs: string[];
  declare parkBackgroundPages: boolean | undefined;
  declare platform: "macos" | "windows" | "linux" | null;
  declare defaultTimeout: number;
  declare liveView: Record<string, any>;
  declare _process: any;
  declare _pending: Map<any, any>;
  declare _pendingCredentialOrigins: Map<any, any>;
  declare _pendingCredentialRecoveries: Map<any, any>;
  declare _workerClosePromises: WeakMap<any, any>;
  declare _workerClosePreservesPending: WeakSet<any>;
  declare _workerCloseBarrier: Promise<any>;
  declare _vaultRedactionOwner: any;
  declare _ready: any;
  declare _lastConfig: any;
  declare _queues: Map<any, any>;
  declare _preparing: any;
  declare _stderrTail: any[];
  declare _closed: boolean;
  declare _liveViewRestore: any;
  declare _workerGeneration: number;
  declare _skills: any[];

  /**
   * @param {object} [options]
   * @param {string} [options.home] state directory (default ~/.betterwright)
   * @param {string} [options.profile] named persistent browser profile inside
   *   the home — a separate identity, with its own cookie jar, lock, and
   *   session daemon, at `browser/profiles/<name>`. Omit it (the default) to
   *   use the single `browser/profile` directory, unchanged. For parallel work
   *   as the *same* identity use `session` names instead; they share one
   *   browser and one cookie jar. The vault, artifacts, and browser binary
   *   cache stay shared across profiles. Names allow letters, digits, ".",
   *   "-", and "_" (starting with a letter or digit; no path separators or
   *   ".."), and are as case-sensitive as the filesystem. An invalid name
   *   throws a TypeError here, at construction.
   * @param {NetworkPolicy} [options.policy] network policy
   * @param {object|false|null} [options.vault] custom vault with
   *   `handleRequest(action, payload, origin)`, or false/null to disable the
   *   built-in encrypted vault
   * @param {boolean} [options.credentialCapture=true] capture accepted logins
   *   in the browser: logins the model types save silently; logins the user
   *   types manually prompt in headed sessions ("Save / Not now / Never for
   *   this site"). Requires a vault; forced off when `vault` is false/null.
   * @param {"cloak"} [options.browser="cloak"] managed CloakBrowser backend
   * @param {boolean|"auto"} [options.headless="auto"] "auto" shows a window when
   *   a display is available and runs headless otherwise; true/false force it
   * @param {number} [options.defaultTimeout=30] per-snippet timeout, seconds
   * @param {number} [options.searchMinIntervalMs=0] minimum spacing between
   *   allowed top-level Google, Bing, or DuckDuckGo search navigations
   * @param {"block"|"allow"} [options.publicSearchPolicy="allow"] set "block"
   *   to route broad discovery through the host search tool instead of letting
   *   the browser use a public search UI (e.g. Google, Bing)
   * @param {"ask"|"allow"|"deny"} [options.downloadPolicy="ask"] require a
   *   trusted host to mark an individual run approved, allow every run, or
   *   deny downloads entirely
   * @param {boolean} [options.stealthRuntimeFix=false] run model snippets in an
   *   isolated world (via the pre-patched `patchright-core` driver) so
   *   `page.evaluate` no longer trips main-world automation detection. Applies
   *   to the managed Cloak browser. Off by default. Trade-off: snippets can no
   *   longer read page-defined main-world globals (e.g. `window.__NEXT_DATA__`);
   *   DOM access and clicks are unaffected. Requires the optional
   *   `patchright-core` dependency to be installed.
   * @param {boolean} [options.cloakV2=true] Cloaking V2: coherent desktop
   *   identity for the managed browser using native CloakBrowser flags and
   *   binary-specific viewport handling. No page-world API shims are installed.
   * @param {string} [options.upstreamProxy] http:// or socks5:// egress proxy
   *   chained through the local policy guard (the IP layer): targets observe
   *   the upstream IP while policy and DNS-rebinding checks stay local.
   *   Optional inline credentials: `socks5://user:pass@host:1080`.
   * @param {boolean} [options.geoip=false] resolve locale/timezone from the
   *   upstream egress IP so JS-layer identity matches network-layer geography.
   *   Requires `upstreamProxy`; explicit `locale`/`timezone` always win.
   * @param {string} [options.locale] browser locale (e.g. "en-US") applied to
   *   the fingerprint flags, Accept-Language, and JS locale surfaces.
   * @param {string} [options.timezone] IANA timezone (e.g. "Europe/Berlin")
   *   applied at the Chromium layer.
   * @param {boolean} [options.headedInvisible=false] run a real headed window
   *   parked off-screen, retaining headed compositing without occupying the
   *   visible desktop.
   * @param {"macos"|"windows"|"linux"} [options.platform] identity platform
   *   presented to sites. The BetterChromium fork defaults to "macos" (a
   *   realistic consumer-Mac fingerprint captured from real Chrome on Apple
   *   Silicon); the managed CloakBrowser path defaults to the host platform.
   * @param {string[]} [options.chromiumArgs] extra Chromium switches appended
   *   to the managed launch arguments, for host-level tuning the managed list
   *   has no opinion on. GPU-less Linux hosts automatically use the packaged
   *   software renderer so WebGL stays available. Also settable per host
   *   via `BETTERWRIGHT_CHROMIUM_ARGS` (whitespace-separated); both apply.
   *   Switches BetterWright owns — proxy, remote debugging, profile directory,
   *   and the `--fingerprint*`/locale/timezone identity family — are rejected
   *   with a `TypeError`, and a switch already present in the managed list is
   *   dropped (with a warning on the next result) so BetterWright's value
   *   always wins.
   * @param {boolean} [options.parkBackgroundPages=true] quiet each session's
   *   pages between executions — page script is disabled and animation
   *   timelines are paused while the model is thinking, and restored before the
   *   next call runs. A headless target never becomes hidden, so without this
   *   every open page renders at the host refresh rate for the life of the
   *   session; parking is what keeps an idle session near zero CPU. Never
   *   applies in headed mode or while a live view is streaming. The one
   *   behavior change: a page animated by a `requestAnimationFrame` chain does
   *   not resume that chain after being parked (CSS/Web Animations do). Set
   *   `false`, or `BETTERWRIGHT_PARK_BACKGROUND_PAGES=0`, to opt out.
   * @param {object} [options.liveView] defaults for {@link startLiveView}:
   *   `{host, port, interactive, quality, maxWidth, publicHost}`. Defaults to
   *   bind `0.0.0.0` with a LAN `publicHost` so printed URLs open from another
   *   machine on the network. Pass `{host:"127.0.0.1"}` for loopback-only.
   */
  constructor(options: BetterWrightOptions = {}) {
    this.home = options.home || defaultHome();
    // null == the historical `browser/profile`. A validated name scopes the
    // profile directory and, through it, the profile lock — nothing else.
    this.profile = resolveProfileName(options.profile);
    this.policy = options.policy || new NetworkPolicy();
    if (Object.hasOwn(options, "vault")) {
      const vault = options.vault;
      if (vault === false || vault == null) this.vault = null;
      else if (typeof vault?.handleRequest === "function") this.vault = vault;
      else
        throw new TypeError(
          "vault must implement handleRequest(action, payload, origin), or be false/null.",
        );
    } else {
      this.vault = createLocalCredentialVault({ home: this.home });
    }
    this.credentialCapture = this.vault
      ? options.credentialCapture !== false
      : false;
    assertManagedCloakOnly(options);
    this.browserFlavor = "cloak";
    this.headless = resolveHeadless(options.headless);
    this.searchMinIntervalMs = Math.max(Number(options.searchMinIntervalMs) || 0, 0);
    this.publicSearchPolicy = resolvePublicSearchPolicy(options.publicSearchPolicy);
    this.downloadPolicy = normalizeDownloadPolicy(options.downloadPolicy);
    this.stealthRuntimeFix = resolveStealthRuntimeFix(options.stealthRuntimeFix);
    this.cloakV2 = options.cloakV2 !== false;
    this.upstreamProxy = options.upstreamProxy || null;
    this.geoip = options.geoip === true;
    this.locale = options.locale || null;
    this.timezone = options.timezone || null;
    this.headedInvisible = options.headedInvisible === true;
    if (this.headedInvisible) this.headless = false;
    // Validate at construction so a bad switch is a clear TypeError here
    // rather than an opaque browser launch failure several calls later. The
    // environment is re-read at launch, so this is validation, not capture.
    this.chromiumArgs = resolveChromiumArgs(options.chromiumArgs);
    // Tri-state on purpose: `undefined` leaves the decision to the worker,
    // which also consults BETTERWRIGHT_PARK_BACKGROUND_PAGES and refuses to
    // park anything a human can see (headed, or a live view streaming).
    this.parkBackgroundPages =
      options.parkBackgroundPages === undefined
        ? undefined
        : options.parkBackgroundPages !== false;
    if (
      options.platform != null &&
      !["macos", "windows", "linux"].includes(options.platform)
    ) {
      throw new TypeError(
        'platform must be "macos", "windows", or "linux".',
      );
    }
    this.platform = options.platform || null;
    this.defaultTimeout = Math.max(Number(options.defaultTimeout) || DEFAULT_TIMEOUT_SECONDS, 5);
    // Live-view defaults ride in each live_view_start message rather than in
    // _workerConfig(), so changing them never restarts the worker. Default is
    // LAN-reachable (0.0.0.0 + guessed private IP in the URL). Persistent
    // settings from <home>/config.json (expose preset, password hash, …) sit
    // between the built-ins and explicit constructor options.
    const lanDefaults = defaultLiveViewListen();
    this.liveView = {
      host: lanDefaults.host,
      port: 0,
      publicHost: lanDefaults.publicHost,
      interactive: true,
      quality: 60,
      maxWidth: 1440,
      ...loadLiveViewConfig(this.home),
      ...(options.liveView && typeof options.liveView === "object"
        ? options.liveView
        : {}),
    };

    this._process = null;
    this._pending = new Map();
    this._pendingCredentialOrigins = new Map();
    this._pendingCredentialRecoveries = new Map();
    this._workerClosePromises = new WeakMap();
    this._workerClosePreservesPending = new WeakSet();
    this._workerCloseBarrier = Promise.resolve();
    this._vaultRedactionOwner = null;
    this._ready = null;
    this._lastConfig = null;
    // One FIFO lane per session, so two sessions genuinely work at the same
    // time (the daemon's whole premise) while calls within a session stay
    // strictly ordered — a snippet must never observe a page another snippet
    // in the same session is halfway through changing. Host-wide operations
    // (live view) share the lane below, matching the worker, which also runs
    // them outside its per-session execute queues.
    this._queues = new Map();
    this._preparing = null;
    this._stderrTail = [];
    this._closed = false;
    // Live-view survival across worker restarts: once startLiveView succeeds,
    // remember the exact options plus the bound port and token so a
    // replacement worker can revive the server on the SAME URL. Cleared by
    // stopLiveView and by a non-restart close.
    this._liveViewRestore = null;
    this._workerGeneration = 0;
  }

  _workerConfig() {
    const root = path.join(this.home, "browser");
    const artifacts = path.join(this.home, "artifacts");
    const downloads = path.join(artifacts, "downloads");
    const runtime = path.join(root, "runtime");
    for (const dir of [root, artifacts, downloads, runtime]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // Only the profile directory — and, derived from it, its lock — is scoped
    // by name: default -> `browser/profile`, a name -> `browser/profiles/<name>`.
    // The runtime, artifacts, and downloads directories created above stay
    // shared, so ephemeral fallbacks and saved files are common to every
    // profile, as is the vault.
    return {
      profileDir: profileDirFor(root, this.profile),
      runtimeDir: runtime,
      artifactsDir: artifacts,
      downloadsDir: downloads,
      browserFlavor: this.browserFlavor,
      stealthRuntimeFix: this.stealthRuntimeFix,
      cloakV2: this.cloakV2,
      upstreamProxy: this.upstreamProxy,
      geoip: this.geoip,
      locale: this.locale,
      timezone: this.timezone,
      headedInvisible: this.headedInvisible,
      platform: this.platform,
      chromiumArgs: this.chromiumArgs,
      parkBackgroundPages: this.parkBackgroundPages,
      headless: this.headless,
      credentialCapture: this.credentialCapture,
      searchMinIntervalMs: this.searchMinIntervalMs,
      publicSearchPolicy: this.publicSearchPolicy,
      downloadPolicy: this.downloadPolicy,
      outputLimit: 12_000,
      maxArtifactBytes: 100 * 1024 * 1024,
      maxDownloadBytes: 50 * 1024 * 1024,
      pageIdleTimeoutMs: 1_800 * 1000,
    };
  }

  async _start() {
    if (
      this._process &&
      this._process.exitCode === null &&
      this._process.signalCode === null
    )
      return;
    if (this._closed) throw new BrowserError("This browser has been closed.");
    // An exited worker can still have buffered stdio. Wait for its `close`
    // cleanup before a replacement is allowed to own the vault redaction set.
    await this._workerCloseBarrier;
    if (
      this._process &&
      this._process.exitCode === null &&
      this._process.signalCode === null
    )
      return;
    if (this._closed) throw new BrowserError("This browser has been closed.");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_NO_WARNINGS: "1",
    };
    const core = resolvePlaywrightCore();
    if (core) env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH = core;

    // Stealth: redirect the worker's (and the Cloak wrapper's) playwright-core
    // to patchright-core by registering a resolve hook at process start, before
    // any driver import runs. `--import` must precede the worker script.
    const execArgv = [];
    if (this.stealthRuntimeFix) {
      const pathHint = String(process.env.BETTERWRIGHT_CHROMIUM_PATH || "").trim();
      const rootHint = String(process.env.BETTERWRIGHT_CHROMIUM_ROOT || "").trim();
      const nativeForkConfigured =
        (pathHint && pathHint.toLowerCase() !== "off") ||
        (rootHint && rootHint.toLowerCase() !== "off");
      if (nativeForkConfigured) {
        throw new BrowserError(
          "stealthRuntimeFix cannot be combined with BetterChromium; " +
            "the native fork requires the pinned stock playwright-core driver.",
        );
      }
      if (!stealthDriverAvailable()) {
        throw new BrowserError(
          "stealthRuntimeFix is enabled but the optional 'patchright-core' " +
            "dependency is not installed. Install it with " +
            "`npm install patchright-core`, or disable stealthRuntimeFix.",
        );
      }
      execArgv.push("--import", STEALTH_REGISTER_URL);
      env.BETTERWRIGHT_STEALTH_ACTIVE = "1";
    }

    const child = spawn(process.execPath, [...execArgv, WORKER_PATH], {
      cwd: path.dirname(WORKER_PATH),
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this._process = child;
    this._workerGeneration += 1;
    this._vaultRedactionOwner = child;
    this._stderrTail = [];

    const stdout = readline.createInterface({ input: child.stdout });
    const rpcTasks = new Set();
    let resolveWorkerClose;
    const workerClosePromise = new Promise(
      (resolve) => (resolveWorkerClose = resolve),
    );
    this._workerClosePromises.set(child, workerClosePromise);
    this._workerCloseBarrier = workerClosePromise;
    let resolveReady;
    this._ready = new Promise((resolve) => (resolveReady = resolve));
    stdout.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === "ready") resolveReady();
      else if (message.type === "rpc_request") {
        const task = this._serviceRpc(message, child);
        rpcTasks.add(task);
        // Custom RPC providers cannot currently be aborted. Their settlement
        // must therefore be observed, but must never hold worker shutdown open.
        void task.then(
          () => rpcTasks.delete(task),
          () => rpcTasks.delete(task),
        );
      }
      else if (message.type === "result") {
        const pending = this._pending.get(String(message.id));
        if (pending?.child === child)
          pending.done(
            this._attachPendingCredentialRecovery(message.id, message),
          );
      }
    });
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) {
        this._stderrTail.push(line);
        if (this._stderrTail.length > 40) this._stderrTail.shift();
      }
    });
    child.on("exit", () => {
      if (this._process === child) this._process = null;
    });
    child.on("close", () => {
      void (async () => {
        let drainTimer;
        try {
          if (rpcTasks.size) {
            await Promise.race([
              Promise.allSettled([...rpcTasks]),
              new Promise((resolve) => {
                drainTimer = setTimeout(resolve, WORKER_RPC_DRAIN_TIMEOUT_MS);
              }),
            ]);
          }
          if (!this._workerClosePreservesPending.has(child)) {
            this._resolvePendingForWorkerExit(child);
          }
        } finally {
          clearTimeout(drainTimer);
          await this._resetVaultRedactionForWorker(child);
          resolveWorkerClose();
          // Unexpected death (crash, OOM-kill) while a live view is up:
          // revive worker + view now, not at the host's next browser call —
          // viewers are already in their reconnect loop. Deliberate closes
          // set _closed (or cleared the restore state) before this fires.
          if (!this._closed && (this._process === child || this._process === null)) {
            this._scheduleLiveViewRevival();
          }
        }
      })().catch(() => {});
    });

    let startTimer;
    const timer = new Promise((_, reject) => {
      startTimer = setTimeout(
        () => reject(new BrowserError(`Worker did not start.\n${this._stderrTail.slice(-8).join("\n")}`)),
        WORKER_START_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this._ready, timer]);
    } finally {
      clearTimeout(startTimer);
    }
  }

  _send(message, child = this._process) {
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      !child.stdin.writable
    )
      throw new BrowserError("The BetterWright worker is not running.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _attachPendingCredentialRecovery(id, message) {
    const key = String(id || "");
    const recovery = this._pendingCredentialRecoveries.get(key);
    if (!recovery) return message;
    this._pendingCredentialRecoveries.delete(key);
    if (message?.ok !== false) return message;
    return { ...message, pendingCredential: recovery };
  }

  _resolvePendingForWorkerExit(child) {
    for (const [id, pending] of this._pending) {
      if (pending.child !== child) continue;
      pending.done(
        this._attachPendingCredentialRecovery(id, {
          type: "result",
          id,
          ok: false,
          error: "The BetterWright worker exited unexpectedly.",
        }),
      );
    }
  }

  async _resetVaultRedactionForWorker(child) {
    if (!child || this._vaultRedactionOwner !== child) return;
    // Retire ownership before calling user code so repeated lifecycle events
    // cannot reset the same generation twice. The worker-close barrier remains
    // pending until this hook settles, so a replacement cannot claim ownership
    // while an older generation's asynchronous reset is still running.
    this._vaultRedactionOwner = null;
    try {
      await this.vault?.resetRedactionSecrets?.();
    } catch {
      /* lifecycle cleanup must never mask worker shutdown */
    }
  }

  _tracksPendingExecution(executionId, child) {
    if (!executionId) return false;
    if (!child) return true;
    return this._pending.get(executionId)?.child === child;
  }

  /**
   * Whether the worker may cache this policy's guard decisions by
   * scheme/host/port. A stock `NetworkPolicy` running its own `check` with no
   * `custom` hook is the only shape whose verdict depends on nothing but those
   * three fields (src/policy.ts); anything that can consult `details`, time, or
   * external state must be re-asked per request.
   *
   * Must be read per RPC, never memoized: `policy`, `policy.custom`, and
   * `policy.check` are all public and mutable, so a hook installed — or a whole
   * policy swapped in — after construction has to invalidate cacheability at
   * once. Method identity is checked too, since `constructor` identity alone
   * still admits an own-property `check` override and Proxy decorators.
   */
  get _policyCacheable() {
    const policy = this.policy;
    return (
      policy?.constructor === NetworkPolicy &&
      policy.check === NetworkPolicy.prototype.check &&
      !policy.custom
    );
  }

  async _serviceRpc(message, child = this._process) {
    const requestId = String(message.requestId || "");
    let response;
    let generatedPendingId = "";
    let generationExecutionId = "";
    try {
      const payload = message.payload || {};
      let result;
      if (message.method === "guard") {
        const { url, ...details } = payload;
        // Copy rather than annotate: policy.check may return a shared or frozen
        // object, and `cacheable` is an envelope field, not part of the public
        // NetworkDecision the policy produced.
        result = { ...this.policy.check(url, details), cacheable: this._policyCacheable };
      } else if (message.method === "vault") {
        if (!this.vault)
          throw new Error(
            "No credential vault is configured for this browser. Configure one, " +
              "or use an unlocked password-manager extension's autofill instead.",
          );
        const action = String(payload.action || "");
        const requestPayload = { ...(payload.payload || {}) };
        if (
          action === "generate" &&
          this._pendingCredentialOrigins.size >= MAX_PENDING_CREDENTIAL_ORIGINS
        ) {
          throw new Error(
            `Too many generated credentials are pending finalization (limit ${MAX_PENDING_CREDENTIAL_ORIGINS}); commit or discard one before generating another.`,
          );
        }
        if (action === "generate") {
          generatedPendingId = String(requestPayload.pendingId ?? "").trim();
          if (!generatedPendingId) {
            generatedPendingId = `pending_${randomUUID()}`;
            requestPayload.pendingId = generatedPendingId;
          }
          generationExecutionId = String(message.id || "");
          this._pendingCredentialOrigins.set(generatedPendingId, String(payload.origin || ""));
          const proposedRecovery = pendingCredentialRecovery(
            requestPayload,
            requestPayload,
            String(payload.origin || ""),
          );
          if (proposedRecovery && generationExecutionId) {
            this._pendingCredentialRecoveries.set(
              generationExecutionId,
              proposedRecovery,
            );
          }
        }
        const pendingId = String(requestPayload.pendingId ?? "").trim();
        const trackedOrigin = pendingId
          ? this._pendingCredentialOrigins.get(pendingId)
          : null;
        const currentOrigin = String(payload.origin || "");
        try {
          result = await this.vault.handleRequest(
            action,
            requestPayload,
            currentOrigin,
          );
        } catch (error) {
          if (
            PENDING_CREDENTIAL_FINALIZE_ACTIONS.has(action) &&
            pendingId &&
            error?.code === "PENDING_NOT_FOUND" &&
            trackedOrigin &&
            trackedOrigin !== currentOrigin
          ) {
            try {
              result = await this.vault.handleRequest(
                action,
                requestPayload,
                trackedOrigin,
              );
            } catch (fallbackError) {
              if (fallbackError?.code === "PENDING_NOT_FOUND") {
                this._pendingCredentialOrigins.delete(pendingId);
              }
              throw fallbackError;
            }
          } else {
            if (
              PENDING_CREDENTIAL_FINALIZE_ACTIONS.has(action) &&
              pendingId &&
              error?.code === "PENDING_NOT_FOUND"
            ) {
              this._pendingCredentialOrigins.delete(pendingId);
            }
            throw error;
          }
        }
        if (action === "generate") {
          const returnedPendingId = String(result?.pendingId ?? "").trim();
          if (!returnedPendingId) {
            const error = new Error(
              "Credential vault generate must return the pendingId it persisted.",
            );
            error.code = "PENDING_ID_REQUIRED";
            throw error;
          }
          if (returnedPendingId !== generatedPendingId) {
            this._pendingCredentialOrigins.delete(generatedPendingId);
            generatedPendingId = returnedPendingId;
          }
          this._pendingCredentialOrigins.set(generatedPendingId, currentOrigin);
          const recovery = pendingCredentialRecovery(
            result,
            requestPayload,
            currentOrigin,
          );
          if (
            recovery &&
            this._tracksPendingExecution(generationExecutionId, child)
          ) {
            this._pendingCredentialRecoveries.set(
              generationExecutionId,
              recovery,
            );
          }
        } else if (
          PENDING_CREDENTIAL_FINALIZE_ACTIONS.has(action) &&
          pendingId
        ) {
          // The await above succeeded, so the pending vault entry is finalized.
          this._pendingCredentialOrigins.delete(pendingId);
          const executionId = String(message.id || "");
          if (
            executionId &&
            this._pendingCredentialRecoveries.get(executionId)?.pendingId ===
              pendingId
          ) {
            this._pendingCredentialRecoveries.delete(executionId);
          }
        }
      } else {
        throw new Error(`Unknown worker RPC method: ${message.method}`);
      }
      response = { type: "rpc_response", requestId, ok: true, result };
    } catch (error) {
      const reportedRecovery = error?.pendingCredential?.pendingId
        ? error.pendingCredential
        : null;
      if (
        reportedRecovery &&
        this._tracksPendingExecution(generationExecutionId, child)
      ) {
        const reportedPendingId = String(reportedRecovery.pendingId);
        if (generatedPendingId && generatedPendingId !== reportedPendingId) {
          this._pendingCredentialOrigins.delete(generatedPendingId);
        }
        generatedPendingId = reportedPendingId;
        this._pendingCredentialOrigins.set(
          generatedPendingId,
          String(reportedRecovery.origin || ""),
        );
        this._pendingCredentialRecoveries.set(
          generationExecutionId,
          reportedRecovery,
        );
      }
      if (
        generatedPendingId &&
        !reportedRecovery &&
        DEFINITIVE_GENERATE_FAILURE_CODES.has(String(error?.code || ""))
      ) {
        this._pendingCredentialOrigins.delete(generatedPendingId);
        if (
          generationExecutionId &&
          this._pendingCredentialRecoveries.get(generationExecutionId)
            ?.pendingId === generatedPendingId
        ) {
          this._pendingCredentialRecoveries.delete(generationExecutionId);
        }
      }
      const pendingCredential =
        reportedRecovery ||
        (generationExecutionId
          ? this._pendingCredentialRecoveries.get(generationExecutionId)
          : null);
      response = {
        type: "rpc_response",
        requestId,
        ok: false,
        error: String(error?.message || error),
        ...(typeof error?.code === "string" ? { code: error.code } : {}),
        ...(pendingCredential ? { pendingCredential } : {}),
      };
    }
    try {
      this._send(response, child);
    } catch {
      /* worker shutting down */
    }
  }

  /**
   * Execute one Playwright snippet and resolve with a result object.
   * @param {string} code asynchronous Playwright JavaScript
   * @param {object} [options] { session, note, timeout, approvedDownloads }
   */
  run(code, options: any = {}) {
    return this._enqueue(options?.session, () => this._runNow(code, options));
  }

  /** The lane a call belongs to; `HOST_LANE` for browser-wide operations. */
  _lane(session) {
    return session === HOST_LANE ? HOST_LANE : String(session || "default");
  }

  _enqueue(session, job): Promise<any> {
    const lane = this._lane(session);
    const tail = this._queues.get(lane) || Promise.resolve();
    const task = tail.then(job);
    // Keep the chain alive even if one run rejects, and drop the lane once it
    // drains so a long-lived browser does not accumulate one dead promise per
    // session name it has ever seen.
    const chained = task.then(
      () => {},
      () => {},
    );
    this._queues.set(lane, chained);
    void chained.then(() => {
      if (this._queues.get(lane) === chained) this._queues.delete(lane);
    });
    return task;
  }

  /**
   * Fill a stored credential into the current page from trusted host code.
   *
   * This never runs model-authored code and never returns the password. The
   * worker fetches the secret over the vault RPC, types the username, password,
   * and (optionally) a confirm-password field, and can submit the form — all
   * outside the model sandbox. Only non-secret metadata comes back.
   *
   * @param {object} options
   * Visible enabled fields are detected from autocomplete semantics, labels,
   * names, types, and form relationships. Explicit CSS or `aria-ref=eN`
   * targets remain available when a page is ambiguous.
   *
   * @param {string} [options.passwordSelector] explicit password field target
   * @param {string} [options.currentPasswordSelector] explicit current-password
   *   target for rotation with generateAndFillCredential
   * @param {string} [options.usernameSelector] explicit username/email target
   * @param {string} [options.confirmPasswordSelector] explicit confirmation target
   *   (signup); filled with the same secret and blurred to trigger match checks
   * @param {string} [options.submitSelector] explicit target clicked to submit
   * @param {boolean} [options.submit=false] detect and click the form's submit
   *   control in the same trusted call, so no model turn sees the secret sitting
   *   in a field
   * @param {string} [options.id] select the stored record by id
   * @param {string} [options.username] select the stored record by username
   * @param {string} [options.session="default"] session name
   * @param {number} [options.timeout] seconds
   */
  fillCredential(options: any = {}) {
    return this._enqueue(options?.session, () => this._fillNow(options));
  }

  /**
   * Generate and fill a strong password (plus any confirmation field), keeping
   * it pending until {@link commitGeneratedCredential} is called after visible
   * success. Mirrors {@link fillCredential} options plus `length`,
   * `includeSymbols`, `label`, and `matchMode`.
   */
  generateAndFillCredential(options: any = {}) {
    return this.fillCredential({ ...options, generate: true });
  }

  /** Promote a visibly verified pending generated credential to an active record. */
  commitGeneratedCredential(options: any = {}) {
    return this._pendingCredential("commit", options);
  }

  /** Remove a pending generated credential after signup/rotation failed. */
  discardGeneratedCredential(options: any = {}) {
    return this._pendingCredential("discard", options);
  }

  /** List secret-free generated credentials recoverable from the current site. */
  listPendingCredentials(options: any = {}) {
    return this._pendingCredential("list", options);
  }

  _pendingCredential(action, options) {
    return this._enqueue(options?.session, async () => {
      if (!options || typeof options !== "object" || Array.isArray(options))
        return { ok: false, error: "pending credential options must be an object." };
      const pendingId = String(options.pendingId ?? "").trim();
      if (action !== "list" && !pendingId)
        return {
          ok: false,
          error: "pending credential options require a non-empty pendingId.",
        };
      const timeoutSeconds = Math.max(
        Number(options.timeout) || this.defaultTimeout,
        5,
      );
      const config = await this._prepare();
      const pendingOrigin = this._pendingCredentialOrigins.get(pendingId);
      const payload =
        action === "list"
          ? {}
          : {
              pendingId,
              ...(pendingOrigin ? { pendingOrigin } : {}),
            };
      return this._dispatch(
        {
          type: "credential_pending",
          action,
          payload,
          sessionId: String(options.session || "default"),
          timeoutMs: timeoutSeconds * 1000,
          config,
        },
        timeoutSeconds,
      );
    });
  }

  async _fillNow(options) {
    if (!options || typeof options !== "object" || Array.isArray(options))
      return { ok: false, error: "fillCredential options must be an object." };
    let spec;
    try {
      spec = buildFillSpec(options);
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
    const timeoutSeconds = Math.max(Number(options.timeout) || this.defaultTimeout, 5);
    const config = await this._prepare();
    return this._dispatch(
      {
        type: "credential_fill",
        sessionId: String(options.session || "default"),
        timeoutMs: timeoutSeconds * 1000,
        spec,
        config,
      },
      timeoutSeconds,
    );
  }

  async _runNow(code, options) {
    if (typeof code !== "string" || !code.trim())
      return { ok: false, error: "code must be a non-empty string" };
    const timeoutSeconds = Math.max(Number(options.timeout) || this.defaultTimeout, 5);
    const config = await this._prepare();
    return this._dispatch(
      {
        type: "execute",
        sessionId: String(options.session || "default"),
        code,
        approvedDownloads: options.approvedDownloads === true,
        timeoutMs: timeoutSeconds * 1000,
        config,
      },
      timeoutSeconds,
    );
  }

  /**
   * Close one session's pages and forget its state (tabs, `state`, cursor)
   * without touching the browser, the profile, or other sessions. Resolves
   * with `{ok, closed, pagesClosed}`; a no-op when the worker is not running
   * or the session does not exist.
   * @param {string} [session="default"] session name
   */
  closeSession(session) {
    // The session's own lane, so teardown lands behind that session's
    // in-flight work and cannot race a snippet still touching its pages.
    return this._enqueue(session, async () => {
      if (
        !this._process ||
        this._process.exitCode !== null ||
        this._process.signalCode !== null
      )
        return { ok: true, closed: false, pagesClosed: 0 };
      return this._dispatch(
        { type: "session_close", sessionId: String(session || "default") },
        30,
      );
    });
  }

  /**
   * Start (or return the already-running) live-view server in the worker: a
   * token-gated local web page that streams the live browser and, when
   * interactive, relays the viewer's mouse and keyboard into it.
   *
   * Resolves with `{ok, url, host, port, token, interactive, viewers}`. The
   * `url` embeds a per-start capability token; anyone holding it can watch
   * (and drive, when interactive) the session — treat it like a password.
   *
   * @param {object} [options] overrides for the constructor's `liveView`
   *   defaults: { expose, password, host, port, interactive, quality,
   *   maxWidth, publicHost, session } — `expose` is a one-word hosting preset
   *   ("lan" | "local" | "tailscale") that overrides host/publicHost,
   *   `password` adds a login gate on top of the URL token, and `session`
   *   picks which session's current tab streams first.
   */
  startLiveView(options: any = {}) {
    return this._enqueue(HOST_LANE, async () => {
      const config = await this._prepare();
      const merged = { ...this.liveView, ...options };
      const result = await this._dispatch(
        { type: "live_view_start", config, options: merged },
        30,
      );
      if (result?.ok && result.url) {
        // Pin the bound port and token so a worker restart revives the view
        // on the same URL (see _prepare); viewers reconnect seamlessly.
        this._liveViewRestore = {
          options: { ...merged, port: result.port, token: result.token },
          generation: this._workerGeneration,
        };
      }
      return result;
    });
  }

  /** Stop the live-view server (no-op when it is not running). */
  stopLiveView() {
    return this._enqueue(HOST_LANE, async () => {
      this._liveViewRestore = null;
      if (!this._process || this._process.exitCode !== null)
        return { ok: true, running: false };
      return this._dispatch({ type: "live_view_stop" }, 30);
    });
  }

  /** Report the live-view server state: `{ok, running, url?, viewers?, handoff?}`. */
  liveViewStatus() {
    return this._enqueue(HOST_LANE, async () => {
      if (!this._process || this._process.exitCode !== null)
        return { ok: true, running: false };
      return this._dispatch({ type: "live_view_status" }, 30);
    });
  }

  /**
   * Block until a human finishes a handoff in the live viewer.
   *
   * Requires a running live view (see {@link startLiveView}). The viewer
   * switches into handoff mode — prompt banner, input force-enabled, Done and
   * Cancel buttons — and this resolves with `{ok, action: "done"|"cancel"|
   * "timeout", note}` when the human clicks one (the note is their optional
   * message back to the caller).
   *
   * Deliberately NOT serialized behind the run() queue, so a queued execute
   * can never deadlock a pending handoff. `timeout` (seconds, default 1800)
   * is a hard bound: per BetterWright's timeout semantics, letting it expire
   * client-side restarts the worker, so the worker resolves `action:
   * "timeout"` slightly earlier to keep the browser alive.
   *
   * @param {object} [options] { session, prompt, timeout }
   */
  async waitForHandoff(options: any = {}) {
    if (this._closed) throw new BrowserError("This browser has been closed.");
    if (!this._process || this._process.exitCode !== null) {
      return {
        ok: false,
        error: "Live view is not running; call startLiveView() first.",
      };
    }
    const timeoutSeconds = Math.max(Number(options.timeout) || 1_800, 5);
    return this._dispatch(
      {
        type: "handoff_wait",
        sessionId: String(options.session || "default"),
        prompt: String(options.prompt || ""),
        // Resolve inside the worker a beat before the client's restart timer.
        timeoutMs: timeoutSeconds * 1000,
      },
      timeoutSeconds,
    );
  }

  /**
   * Post a line into the live-view chat (agent steps, system notices). No-op
   * friendly when the viewer is not running.
   *
   * @param {object} [options] { role?: "agent"|"system"|"you", text, kind? }
   */
  async liveViewPostChat(options: any = {}) {
    if (this._closed) throw new BrowserError("This browser has been closed.");
    if (!this._process || this._process.exitCode !== null) {
      return { ok: false, error: "Live view is not running." };
    }
    return this._dispatch(
      {
        type: "live_view_chat_post",
        role: String(options.role || "agent"),
        text: String(options.text || ""),
        kind: options.kind != null ? String(options.kind) : undefined,
      },
      10,
    );
  }

  /**
   * Drain freeform human messages typed in the live-view chat since the last
   * drain. Returns `{ok, messages: [{text, at}]}`. Used by the agent harness
   * between turns so guidance arrives at a safe turn boundary.
   */
  async liveViewDrainChat() {
    if (this._closed) throw new BrowserError("This browser has been closed.");
    if (!this._process || this._process.exitCode !== null) {
      return { ok: true, messages: [] };
    }
    return this._dispatch({ type: "live_view_chat_drain" }, 10);
  }

  /**
   * Block until a human answers an agent question in the live-view chat.
   *
   * Same timeout / non-queue semantics as {@link waitForHandoff}. Resolves with
   * `{ok, action: "answer"|"timeout"|"cancel", answer}`.
   *
   * @param {object} [options] { session, question, options, timeout }
   */
  async waitForAsk(options: any = {}) {
    if (this._closed) throw new BrowserError("This browser has been closed.");
    if (!this._process || this._process.exitCode !== null) {
      return {
        ok: false,
        error: "Live view is not running; call startLiveView() first.",
      };
    }
    const timeoutSeconds = Math.max(Number(options.timeout) || 1_800, 5);
    const choices = Array.isArray(options.options) ? options.options.map(String) : [];
    return this._dispatch(
      {
        type: "ask_wait",
        sessionId: String(options.session || "default"),
        question: String(options.question || ""),
        options: choices,
        timeoutMs: timeoutSeconds * 1000,
      },
      timeoutSeconds,
    );
  }

  /** Restart the worker on a config change and return the current config. */
  /**
   * Ensure the worker is up and matches the current config.
   *
   * Single-flight: with per-session lanes several sessions can arrive here at
   * once, and `_prepareNow` is not re-entrant — two concurrent callers would
   * race to spawn two workers. Concurrent callers share one preparation and
   * get the same config back.
   */
  _prepare() {
    if (this._preparing) return this._preparing;
    const preparing = this._prepareNow();
    this._preparing = preparing;
    const release = () => {
      if (this._preparing === preparing) this._preparing = null;
    };
    preparing.then(release, release);
    return preparing;
  }

  async _prepareNow() {
    const config = this._workerConfig();
    if (
      this._process &&
      this._process.exitCode === null &&
      JSON.stringify(this._lastConfig) !== JSON.stringify(config)
    ) {
      await this.close();
      this._closed = false;
    }
    await this._start();
    this._lastConfig = config;
    const restore = this._liveViewRestore;
    if (restore && restore.generation !== this._workerGeneration) {
      // The worker restarted under a running live view (timeout, crash,
      // BW_TIMEOUT). Revive the server in the replacement worker with the
      // pinned port + token so the original URL — and every viewer's
      // reconnect loop — keeps working. One attempt per worker generation;
      // if the revival fails (e.g. the port got taken), drop the state so
      // failures don't loop.
      restore.generation = this._workerGeneration;
      const revived = await this._dispatch(
        { type: "live_view_start", config, options: restore.options },
        30,
      );
      if (!revived?.ok) this._liveViewRestore = null;
    }
    return config;
  }

  /** Send one worker command keyed by a fresh id and await its result envelope,
   * restarting the worker on timeout and applying vault redaction on the way
   * out. Shared by run() and fillCredential(). */
  async _dispatch(message, timeoutSeconds): Promise<any> {
    const id = `${process.pid}-${Math.round(performance.now() * 1000)}-${this._pending.size}`;
    const child = this._process;
    const response: any = await new Promise<any>((resolve) => {
      let settled = false;
      let timer;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._pending.delete(id);
        resolve(result);
      };
      this._pending.set(id, { child, done });
      timer = setTimeout(async () => {
        await this.close({ child, preservePending: true, restart: true });
        this._closed = false;
        this._scheduleLiveViewRevival();
        done(
          this._attachPendingCredentialRecovery(id, {
            ok: false,
            error: `Execution timed out after ${timeoutSeconds}s; the worker was restarted.`,
          }),
        );
      }, (timeoutSeconds + 5) * 1000);
      try {
        this._send({ ...message, id }, child);
      } catch (error) {
        done({ ok: false, error: String(error?.message || error) });
      }
    });

    delete response.type;
    delete response.id;
    const restart = Boolean(response.restartWorker);
    delete response.restartWorker;
    let envelope = response;
    if (this.vault && typeof this.vault.redact === "function") {
      try {
        envelope = this.vault.redact(response);
      } catch {
        // Fail closed: if redaction itself breaks, the raw response may still
        // carry active secrets, so the whole envelope is withheld rather than
        // returned unscrubbed. Only pendingCredential survives — it is
        // documented secret-free and losing it would strand a staged
        // generated credential with no way to commit or discard it.
        envelope = {
          ok: false,
          error: "Result withheld: secret redaction failed.",
          ...(response.pendingCredential
            ? { pendingCredential: response.pendingCredential }
            : {}),
        };
      }
    }
    if (Array.isArray(envelope.pages) && envelope.pages.length) {
      try {
        this._skills ??= listSkills();
        const skills = skillHintsForPages(envelope.pages, { skills: this._skills });
        if (skills.length) envelope.skills = skills;
      } catch {
        /* skill hints must never break a result */
      }
    }
    if (restart) {
      await this.close({ restart: true });
      this._closed = false;
      this._scheduleLiveViewRevival();
    }
    return envelope;
  }

  /** After a worker restart with an active live view, bring the replacement
   * worker (and the view, on its original URL) up immediately in the
   * background — like a daemon, viewers reconnect within seconds instead of
   * waiting for the host's next browser call. Best-effort by design. */
  _scheduleLiveViewRevival() {
    if (!this._liveViewRestore) return;
    void this._enqueue(HOST_LANE, () => this._prepare()).catch(() => {});
  }

  async close(
    {
      child: requestedChild = null,
      preservePending = false,
      restart = false,
    }: any = {},
  ) {
    this._closed = true;
    const child = requestedChild || this._process;
    const closesActiveWorker = !requestedChild || this._process === child;
    if (closesActiveWorker) {
      this._process = null;
      this._lastConfig = null;
    }
    // A final close ends the live view for good: tell viewers (worker
    // teardown alone stays silent so restart reconnects work) and drop the
    // revival state. Restart closes keep both so the view comes back.
    const endsLiveView = !restart && this._liveViewRestore;
    if (endsLiveView) this._liveViewRestore = null;
    if (!child) {
      await this._workerCloseBarrier;
      return;
    }
    if (preservePending) this._workerClosePreservesPending.add(child);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (endsLiveView) {
          // Best-effort "bye" to viewers; the worker reads it before EOF.
          this._send({ type: "live_view_stop", id: "close-live-view" }, child);
        }
        child.stdin.end();
      } catch {
        /* already closed */
      }
    }
    const closed = this._workerClosePromises.get(child) || once(child, "close");
    const killer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 5_000);
    try {
      await closed;
    } finally {
      clearTimeout(killer);
      await this._resetVaultRedactionForWorker(child);
    }
  }
}

export { NetworkPolicy };
