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

function defaultHome() {
  const configured = (process.env.BETTERWRIGHT_HOME || "").trim();
  return configured || path.join(os.homedir(), ".betterwright");
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
   * @param {string} [options.executablePath] explicit Chromium binary
   * @param {boolean|"auto"} [options.headless="auto"] "auto" shows a window when
   *   a display is available and runs headless otherwise; true/false force it
   * @param {number} [options.defaultTimeout=30] per-snippet timeout, seconds
   * @param {string} [options.connectOverCdp] attach to a Chrome started with
   *   --remote-debugging-port at this endpoint (e.g. "http://127.0.0.1:9222")
   *   instead of launching one; the launch-time network floor is inactive in
   *   this mode — only the per-request policy applies.
   */
  constructor(options = {}) {
    this.home = options.home || defaultHome();
    this.policy = options.policy || new NetworkPolicy();
    this.vault = options.vault || null;
    this.executablePath = options.executablePath || "";
    this.headless = resolveHeadless(options.headless);
    this.connectOverCdp = (options.connectOverCdp || "").trim();
    this.defaultTimeout = Math.max(Number(options.defaultTimeout) || DEFAULT_TIMEOUT_SECONDS, 5);

    this._process = null;
    this._pending = new Map();
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
    const vault = path.join(this.home, "vault");
    for (const dir of [root, artifacts, downloads, runtime]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return {
      profileDir: path.join(root, "profile"),
      runtimeDir: runtime,
      artifactsDir: artifacts,
      downloadsDir: downloads,
      executablePath: this.executablePath,
      headless: this.headless,
      cdpEndpoint: this.connectOverCdp,
      outputLimit: 12_000,
      maxArtifactBytes: 100 * 1024 * 1024,
      maxDownloadBytes: 50 * 1024 * 1024,
      pageIdleTimeoutMs: 1_800 * 1000,
      privateRoots: [path.join(root, "profile"), vault, runtime],
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
   * @param {object} [options] { session, note, timeout }
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

  async _runNow(code, options) {
    if (typeof code !== "string" || !code.trim())
      return { ok: false, error: "code must be a non-empty string" };
    const timeoutSeconds = Math.max(Number(options.timeout) || this.defaultTimeout, 5);
    const config = this._workerConfig();
    if (this._process && this._process.exitCode === null && JSON.stringify(this._lastConfig) !== JSON.stringify(config)) {
      await this.close();
      this._closed = false;
    }
    await this._start();
    this._lastConfig = config;

    const id = `${process.pid}-${Math.round(performance.now() * 1000)}-${this._pending.size}`;
    const response = await new Promise((resolve) => {
      let settled = false;
      const done = (message) => {
        if (settled) return;
        settled = true;
        this._pending.delete(id);
        resolve(message);
      };
      this._pending.set(id, done);
      const timer = setTimeout(async () => {
        await this.close();
        this._closed = false;
        done({ ok: false, error: `Execution timed out after ${timeoutSeconds}s; the worker was restarted.` });
      }, (timeoutSeconds + 5) * 1000);
      try {
        this._send({
          type: "execute",
          id,
          sessionId: String(options.session || "default"),
          code,
          timeoutMs: timeoutSeconds * 1000,
          config,
        });
      } catch (error) {
        clearTimeout(timer);
        done({ ok: false, error: String(error?.message || error) });
        return;
      }
      const original = done;
      this._pending.set(id, (message) => {
        clearTimeout(timer);
        original(message);
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
