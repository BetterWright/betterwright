// The Node client for BetterWright.
//
// It owns one long-lived worker process, answers the worker's `guard` (network
// policy) and `vault` (credential) RPCs, and exposes `run()` for executing
// Playwright snippets. It mirrors the Python client so both share one runtime.

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { normalizeDownloadPolicy } from "./downloads.mjs";
import { NetworkPolicy } from "./policy.mjs";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const DEFAULT_TIMEOUT_SECONDS = 30;
const WORKER_START_TIMEOUT_MS = 15_000;

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

function resolveBrowser(browser) {
  const value = String(
    browser ?? process.env.BETTERWRIGHT_BROWSER ?? "cloak",
  )
    .trim()
    .toLowerCase();
  if (!["cloak", "chromium"].includes(value)) {
    throw new TypeError('browser must be "cloak" or "chromium".');
  }
  return value;
}

function resolvePublicSearchPolicy(policy) {
  const value = String(
    policy ?? process.env.BETTERWRIGHT_PUBLIC_SEARCH_POLICY ?? "block",
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
  const fields = {
    passwordSelector: options.passwordSelector,
    usernameSelector: options.usernameSelector,
    confirmPasswordSelector: options.confirmPasswordSelector,
    submitSelector: options.submitSelector,
  };
  if (options.generate) {
    return {
      action: "generate",
      fields,
      generate: {
        username: options.username ?? "",
        label: options.label ?? null,
        length: options.length,
        includeSymbols: options.includeSymbols,
      },
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

/** A persistent, policy-guarded Playwright browser. */
export class BetterWright {
  /**
   * @param {object} [options]
   * @param {string} [options.home] state directory (default ~/.betterwright)
   * @param {NetworkPolicy} [options.policy] network policy
   * @param {object} [options.vault] optional vault with `handleRequest(action, payload, origin)`
   * @param {"cloak"|"chromium"} [options.browser="cloak"] managed browser;
   *   stock Chromium is an explicit degraded fallback
   * @param {string} [options.executablePath] explicit Chromium binary; selecting
   *   one also selects the Chromium fallback
   * @param {boolean|"auto"} [options.headless="auto"] "auto" shows a window when
   *   a display is available and runs headless otherwise; true/false force it
   * @param {number} [options.defaultTimeout=30] per-snippet timeout, seconds
   * @param {string} [options.connectOverCdp] attach to a Chrome started with
   *   --remote-debugging-port at this endpoint (e.g. "http://127.0.0.1:9222")
   *   instead of launching one; the launch-time network floor is inactive in
   *   this mode — only the per-request policy applies. Pass "auto" to reuse a
   *   debug Chrome if one is already running, or otherwise launch a real Google
   *   Chrome with a persistent BetterWright profile (where you install and unlock
   *   a password-manager extension once) and attach to that.
   * @param {number} [options.searchMinIntervalMs=0] minimum spacing between
   *   allowed top-level Google, Bing, or DuckDuckGo search navigations
   * @param {"block"|"allow"} [options.publicSearchPolicy="block"] route broad
   *   discovery through the host search tool instead of a public search UI
   * @param {"ask"|"allow"|"deny"} [options.downloadPolicy="ask"] require a
   *   trusted host to mark an individual run approved, allow every run, or
   *   deny downloads entirely
   */
  constructor(options = {}) {
    this.home = options.home || defaultHome();
    this.policy = options.policy || new NetworkPolicy();
    this.vault = options.vault || null;
    const requestedBrowser = resolveBrowser(options.browser);
    this.browserFlavor = options.executablePath ? "chromium" : requestedBrowser;
    const cloakExecutable = (process.env.CLOAKBROWSER_BINARY_PATH || "").trim();
    this.executablePath =
      options.executablePath ||
      (this.browserFlavor === "cloak" ? cloakExecutable : "");
    this.headless = resolveHeadless(options.headless);
    this.connectOverCdp = (options.connectOverCdp || "").trim();
    this.searchMinIntervalMs = Math.max(Number(options.searchMinIntervalMs) || 0, 0);
    this.publicSearchPolicy = resolvePublicSearchPolicy(options.publicSearchPolicy);
    this.downloadPolicy = normalizeDownloadPolicy(options.downloadPolicy);
    this.defaultTimeout = Math.max(Number(options.defaultTimeout) || DEFAULT_TIMEOUT_SECONDS, 5);

    this._process = null;
    this._pending = new Map();
    this._ready = null;
    this._lastConfig = null;
    this._queue = Promise.resolve();
    this._stderrTail = [];
    this._closed = false;
    this._cdpResolved = false;
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
      // Each browser flavor gets its own profile directory. Cloak and the
      // stock-Chromium fallback ship different Chromium versions; sharing one
      // profile lets the newer binary silently upgrade it out from under the
      // older one, after which the older binary crashes on launch (a newer
      // profile is not downgrade-safe). Cloak keeps the historical "profile"
      // path so existing saved logins survive an upgrade.
      profileDir: path.join(
        root,
        this.browserFlavor === "chromium" ? "profile-chromium" : "profile",
      ),
      runtimeDir: runtime,
      artifactsDir: artifacts,
      downloadsDir: downloads,
      executablePath: this.executablePath,
      browserFlavor: this.browserFlavor,
      headless: this.headless,
      cdpEndpoint: this.connectOverCdp,
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
    if (this._process && this._process.exitCode === null) return;
    if (this._closed) throw new BrowserError("This browser has been closed.");
    const env = { ...process.env, NODE_NO_WARNINGS: "1" };
    const core = resolvePlaywrightCore();
    if (core) env.BETTERWRIGHT_PLAYWRIGHT_CORE_PATH = core;

    const child = spawn(process.execPath, [WORKER_PATH], {
      cwd: path.dirname(WORKER_PATH),
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this._process = child;
    this._stderrTail = [];

    const stdout = readline.createInterface({ input: child.stdout });
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
      else if (message.type === "rpc_request") this._serviceRpc(message);
      else if (message.type === "result") {
        const waiter = this._pending.get(String(message.id));
        if (waiter) waiter(message);
      }
    });
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) {
        this._stderrTail.push(line);
        if (this._stderrTail.length > 40) this._stderrTail.shift();
      }
    });
    child.on("exit", () => {
      const error = {
        type: "result",
        ok: false,
        error: "The BetterWright worker exited unexpectedly.",
      };
      for (const waiter of this._pending.values()) waiter(error);
      if (this._process === child) this._process = null;
    });

    const timer = new Promise((_, reject) =>
      setTimeout(
        () => reject(new BrowserError(`Worker did not start.\n${this._stderrTail.slice(-8).join("\n")}`)),
        WORKER_START_TIMEOUT_MS,
      ),
    );
    await Promise.race([this._ready, timer]);
  }

  _send(message) {
    if (!this._process || this._process.exitCode !== null || !this._process.stdin.writable)
      throw new BrowserError("The BetterWright worker is not running.");
    this._process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async _serviceRpc(message) {
    const requestId = String(message.requestId || "");
    let response;
    try {
      const payload = message.payload || {};
      let result;
      if (message.method === "guard") {
        const { url, ...details } = payload;
        result = this.policy.check(url, details);
      } else if (message.method === "vault") {
        if (!this.vault) throw new Error("No credential vault is configured for this browser.");
        result = await this.vault.handleRequest(
          String(payload.action || ""),
          payload.payload || {},
          String(payload.origin || ""),
        );
      } else {
        throw new Error(`Unknown worker RPC method: ${message.method}`);
      }
      response = { type: "rpc_response", requestId, ok: true, result };
    } catch (error) {
      response = { type: "rpc_response", requestId, ok: false, error: String(error?.message || error) };
    }
    try {
      this._send(response);
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
    const task = this._queue.then(() => this._runNow(code, options));
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
   * @param {string} options.passwordSelector required password field selector
   * @param {string} [options.usernameSelector] username/email field selector
   * @param {string} [options.confirmPasswordSelector] confirm-password selector
   *   (signup); filled with the same secret and blurred to trigger match checks
   * @param {string} [options.submitSelector] click this to submit in the same
   *   trusted call, so no model turn sees the secret sitting in a field
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
   * Generate a strong password, store it in the vault scoped to the current
   * origin, and fill it (plus any confirm-password field) — the safe primitive
   * for signing up. Mirrors {@link fillCredential} options plus `length`,
   * `includeSymbols`, and `label`.
   */
  generateAndFillCredential(options = {}) {
    return this.fillCredential({ ...options, generate: true });
  }

  async _fillNow(options) {
    if (!options || typeof options.passwordSelector !== "string" || !options.passwordSelector.trim())
      return { ok: false, error: "fillCredential requires a passwordSelector." };
    const timeoutSeconds = Math.max(Number(options.timeout) || this.defaultTimeout, 5);
    const config = await this._prepare();
    return this._dispatch(
      {
        type: "credential_fill",
        sessionId: String(options.session || "default"),
        timeoutMs: timeoutSeconds * 1000,
        spec: buildFillSpec(options),
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

  /** Resolve a "auto" CDP endpoint (launch/reuse a real Chrome), restart the
   * worker on a config change, and return the current worker config. */
  async _prepare() {
    await this._resolveCdpEndpoint();
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

  async _resolveCdpEndpoint() {
    if (this._cdpResolved) return;
    if (String(this.connectOverCdp || "").trim().toLowerCase() === "auto") {
      const { ensureChromeCdp } = await import("./chrome.mjs");
      const { endpoint } = await ensureChromeCdp({ home: this.home });
      this.connectOverCdp = endpoint;
    }
    this._cdpResolved = true;
  }

  /** Send one worker command keyed by a fresh id and await its result envelope,
   * restarting the worker on timeout and applying vault redaction on the way
   * out. Shared by run() and fillCredential(). */
  async _dispatch(message, timeoutSeconds) {
    const id = `${process.pid}-${Math.round(performance.now() * 1000)}-${this._pending.size}`;
    const response = await new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        this._pending.delete(id);
        resolve(result);
      };
      this._pending.set(id, done);
      const timer = setTimeout(async () => {
        await this.close();
        this._closed = false;
        done({ ok: false, error: `Execution timed out after ${timeoutSeconds}s; the worker was restarted.` });
      }, (timeoutSeconds + 5) * 1000);
      try {
        this._send({ ...message, id });
      } catch (error) {
        clearTimeout(timer);
        done({ ok: false, error: String(error?.message || error) });
        return;
      }
      this._pending.set(id, (result) => {
        clearTimeout(timer);
        done(result);
      });
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
    if (restart) {
      await this.close();
      this._closed = false;
    }
    return envelope;
  }

  async close() {
    this._closed = true;
    const child = this._process;
    this._process = null;
    this._lastConfig = null;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    const exited = once(child, "exit");
    const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(killer);
  }
}

export { NetworkPolicy };
