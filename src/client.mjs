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
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { normalizeDownloadPolicy } from "./downloads.mjs";
import { NetworkPolicy } from "./policy.mjs";
import { listSkills, skillHintsForPages } from "./skills.mjs";
import { createLocalCredentialVault, VAULT_MATCH_MODES } from "./vault.mjs";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const DEFAULT_TIMEOUT_SECONDS = 30;
const WORKER_START_TIMEOUT_MS = 15_000;
const WORKER_RPC_DRAIN_TIMEOUT_MS = 250;
const MAX_PENDING_CREDENTIAL_ORIGINS = 100;
const VAULT_MATCH_MODE_SET = new Set(VAULT_MATCH_MODES);
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

export function validateCredentialMatchMode(value) {
  if (typeof value !== "string" || !VAULT_MATCH_MODE_SET.has(value)) {
    throw new TypeError(
      'matchMode must be "base-domain", "host", "exact-origin", or "never".',
    );
  }
  return value;
}

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
      'BetterWright only supports the managed CloakBrowser backend; browser must be "cloak".',
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

function resolvePublicSearchPolicy(policy) {
  const value = String(
    policy ?? process.env.BETTERWRIGHT_PUBLIC_SEARCH_POLICY ?? "allow",
  )
    .trim()
    .toLowerCase();
  if (!["block", "allow"].includes(value)) {
    throw new TypeError('publicSearchPolicy must be "block" or "allow".');
  }
  return value;
}

function defaultHome() {
  const configured = (process.env.BETTERWRIGHT_HOME || "").trim();
  return configured || path.join(os.homedir(), ".betterwright");
}

/** Translate host-facing fillCredential options into the worker `spec`. */
function buildFillSpec(options) {
  const fields = {};
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
    if (options.id != null && options.matchMode !== undefined) {
      throw new TypeError(
        "matchMode cannot be changed when rotating an existing credential; " +
          "omit matchMode to preserve the saved record scope.",
      );
    }
    const generate = {};
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

function pendingCredentialRecovery(result, requestPayload, origin) {
  const pendingId = String(result?.pendingId ?? "").trim();
  if (!pendingId) return null;
  const resultMatchMode = String(result?.matchMode ?? "").trim();
  const requestedMatchMode = String(requestPayload?.matchMode ?? "").trim();
  const matchMode = VAULT_MATCH_MODE_SET.has(resultMatchMode)
    ? resultMatchMode
    : VAULT_MATCH_MODE_SET.has(requestedMatchMode)
      ? requestedMatchMode
      : "base-domain";
  const resultObject = result && typeof result === "object" ? result : {};
  const payloadObject =
    requestPayload && typeof requestPayload === "object" ? requestPayload : {};
  const username = Object.hasOwn(resultObject, "username")
    ? resultObject.username
    : Object.hasOwn(payloadObject, "username")
      ? payloadObject.username
      : null;
  const label = Object.hasOwn(resultObject, "label")
    ? resultObject.label
    : Object.hasOwn(payloadObject, "label")
      ? payloadObject.label
      : null;
  return {
    pendingId,
    // This is where the form was filled, not an existing record's saved scope.
    origin: String(origin),
    matchMode,
    username: username == null ? null : String(username),
    label: label == null ? null : String(label),
    expiresAt:
      result?.expiresAt == null ? null : String(result.expiresAt),
  };
}

function resolvePlaywrightCore() {
  const override = (process.env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH || "").trim();
  if (override) return override;
  // A sibling node_modules (normal npm install) is resolved by the worker's
  // own bare `import "playwright-core"`, so returning "" is correct there.
  return "";
}

const STEALTH_REGISTER_URL = new URL("./stealth-register.mjs", import.meta.url).href;

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
  /**
   * @param {object} [options]
   * @param {string} [options.home] state directory (default ~/.betterwright)
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
   *   presented to sites. The native Chromium fork defaults to "macos" (a
   *   realistic consumer-Mac fingerprint captured from real Chrome on Apple
   *   Silicon); the managed CloakBrowser path defaults to the host platform.
   */
  constructor(options = {}) {
    this.home = options.home || defaultHome();
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
    this._queue = Promise.resolve();
    this._stderrTail = [];
    this._closed = false;
  }

  _workerConfig() {
    const root = path.join(this.home, "browser");
    const artifacts = path.join(this.home, "artifacts");
    const downloads = path.join(artifacts, "downloads");
    const runtime = path.join(root, "runtime");
    for (const dir of [root, artifacts, downloads, runtime]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return {
      profileDir: path.join(root, "profile"),
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
    const env = { ...process.env, NODE_NO_WARNINGS: "1" };
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
          "stealthRuntimeFix cannot be combined with BetterWright Chromium; " +
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
        result = this.policy.check(url, details);
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
  run(code, options = {}) {
    return this._enqueue(() => this._runNow(code, options));
  }

  _enqueue(job) {
    const task = this._queue.then(job);
    // Keep the chain alive even if one run rejects.
    this._queue = task.then(
      () => {},
      () => {},
    );
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
  fillCredential(options = {}) {
    const task = this._queue.then(() => this._fillNow(options));
    this._queue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  /**
   * Generate and fill a strong password (plus any confirmation field), keeping
   * it pending until {@link commitGeneratedCredential} is called after visible
   * success. Mirrors {@link fillCredential} options plus `length`,
   * `includeSymbols`, `label`, and `matchMode`.
   */
  generateAndFillCredential(options = {}) {
    return this.fillCredential({ ...options, generate: true });
  }

  /** Promote a visibly verified pending generated credential to an active record. */
  commitGeneratedCredential(options = {}) {
    return this._pendingCredential("commit", options);
  }

  /** Remove a pending generated credential after signup/rotation failed. */
  discardGeneratedCredential(options = {}) {
    return this._pendingCredential("discard", options);
  }

  /** List secret-free generated credentials recoverable from the current site. */
  listPendingCredentials(options = {}) {
    return this._pendingCredential("list", options);
  }

  _pendingCredential(action, options) {
    const task = this._queue.then(async () => {
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
    this._queue = task.then(
      () => {},
      () => {},
    );
    return task;
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

  /** Restart the worker on a config change and return the current config. */
  async _prepare() {
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
    return config;
  }

  /** Send one worker command keyed by a fresh id and await its result envelope,
   * restarting the worker on timeout and applying vault redaction on the way
   * out. Shared by run() and fillCredential(). */
  async _dispatch(message, timeoutSeconds) {
    const id = `${process.pid}-${Math.round(performance.now() * 1000)}-${this._pending.size}`;
    const child = this._process;
    const response = await new Promise((resolve) => {
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
        await this.close({ child, preservePending: true });
        this._closed = false;
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
        /* redaction must never throw out */
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
      await this.close();
      this._closed = false;
    }
    return envelope;
  }

  async close({ child: requestedChild = null, preservePending = false } = {}) {
    this._closed = true;
    const child = requestedChild || this._process;
    const closesActiveWorker = !requestedChild || this._process === child;
    if (closesActiveWorker) {
      this._process = null;
      this._lastConfig = null;
    }
    if (!child) {
      await this._workerCloseBarrier;
      return;
    }
    if (preservePending) this._workerClosePreservesPending.add(child);
    if (child.exitCode === null && child.signalCode === null) {
      try {
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
