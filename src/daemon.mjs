// The BetterWright session daemon.
//
// One background process per BETTERWRIGHT_HOME owns a single BetterWright
// instance — policy guard, stealth hooks, vault, worker, browser — and serves
// thin CLI clients over a local socket. This is what makes `betterwright run`
// and `betterwright exec` persistent: open tabs, in-page state, and the repl
// `state` object live here between invocations, keyed by `--session` name,
// until the session is closed explicitly or idles out. The Playwright layer
// (network-policy routes, stealth hooks, credential capture) never tears down
// between calls, so there is no unguarded window and nothing to rewire.
//
// Protocol: newline-delimited JSON over a unix domain socket (win32: a named
// pipe). Requests are `{id, op, ...}`; responses `{id, ok, ...}`. Ops:
//   hello         {version, configSig}     -> {ok, pid, version, configSig,
//                                              withVault, sessions}
//   call          {method, args, session}  -> {ok, result} for a whitelisted
//                                             BetterWright method; the daemon
//                                             pins `session` into the options
//   exec          {task, model, modelOptions, session, fresh?, liveView?}
//                                          -> streamed `{id, ok, event:"step",
//                                             step}` lines while the agent
//                                             works, then a final `{id, ok,
//                                             result}` summary. The agent loop
//                                             (src/agent.mjs) runs HERE, in
//                                             the daemon — the Aside shape —
//                                             so its conversation history and
//                                             browser session both live across
//                                             CLI invocations; history is also
//                                             persisted (elided) to disk via
//                                             src/session-store.mjs so resume
//                                             survives a daemon restart.
//   close_session {session}                -> {ok, closed, pagesClosed}
//   status        {}                       -> same payload as hello
//   shutdown      {}                       -> {ok}, then the daemon exits
//
// Auth model: filesystem permissions (socket 0600 inside the 0700 home), the
// ssh-agent shape — same-user processes only. Sessions are collaboration
// scopes, not a security boundary.
//
// Lifecycle: sessions idle out after BETTERWRIGHT_SESSION_TTL_SECONDS
// (default 900); the daemon exits on its own once no sessions remain.

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { BetterWright, NetworkPolicy } from "./client.mjs";

const require = createRequire(import.meta.url);

export const DAEMON_PROTOCOL = 1;
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MIN_SESSION_TTL_MS = 30_000;
const EMPTY_GRACE_MS = 60_000;
const REAP_INTERVAL_MS = 15_000;

export function daemonPackageVersion() {
  try {
    return String(require("../package.json").version || "0");
  } catch {
    return "0";
  }
}

export function defaultDaemonHome() {
  const configured = (process.env.BETTERWRIGHT_HOME || "").trim();
  return configured || path.join(os.homedir(), ".betterwright");
}

export function daemonSocketPath(home = defaultDaemonHome()) {
  if (process.platform === "win32") {
    const hash = crypto
      .createHash("sha256")
      .update(path.resolve(home))
      .digest("hex")
      .slice(0, 16);
    return `\\\\.\\pipe\\betterwright-${hash}`;
  }
  return path.join(home, "daemon.sock");
}

export function daemonInfoPath(home = defaultDaemonHome()) {
  return path.join(home, "daemon.json");
}

export function sessionTtlMs() {
  const raw = Number(process.env.BETTERWRIGHT_SESSION_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_TTL_MS;
  return Math.max(raw * 1000, MIN_SESSION_TTL_MS);
}

/**
 * Canonicalize the browser-shaping options a daemon is launched with, so a
 * client can tell whether a running daemon matches its flags. The signature is
 * the JSON of this canonical form — build both the signature and the actual
 * BetterWright construction from the same object and they can never drift.
 */
export function normalizeDaemonConfig(config = {}) {
  const policy = config.policy && typeof config.policy === "object" ? config.policy : {};
  const cloak = config.cloak && typeof config.cloak === "object" ? config.cloak : {};
  const hosts = (list) =>
    [...new Set((Array.isArray(list) ? list : []).map((h) => String(h).trim().toLowerCase()).filter(Boolean))].sort();
  return {
    protocol: DAEMON_PROTOCOL,
    headless: config.headless !== false,
    policy: {
      allowLoopback: policy.allowLoopback !== false,
      allowPrivateNetwork: policy.allowPrivateNetwork !== false,
      allowHosts: hosts(policy.allowHosts),
      blockHosts: hosts(policy.blockHosts),
    },
    cloak: {
      cloakV2: cloak.cloakV2 !== false,
      upstreamProxy: cloak.upstreamProxy ? String(cloak.upstreamProxy) : null,
      geoip: cloak.geoip === true,
      locale: cloak.locale ? String(cloak.locale) : null,
      timezone: cloak.timezone ? String(cloak.timezone) : null,
      headedInvisible: cloak.headedInvisible === true,
      platform: cloak.platform ? String(cloak.platform) : null,
      stealthRuntimeFix: cloak.stealthRuntimeFix === true,
    },
  };
}

export function daemonConfigSignature(config) {
  return JSON.stringify(normalizeDaemonConfig(config));
}

export function createBrowserFromDaemonConfig(config) {
  const normalized = normalizeDaemonConfig(config);
  return new BetterWright({
    policy: new NetworkPolicy(normalized.policy),
    headless: normalized.headless,
    cloakV2: normalized.cloak.cloakV2,
    upstreamProxy: normalized.cloak.upstreamProxy || undefined,
    geoip: normalized.cloak.geoip,
    locale: normalized.cloak.locale || undefined,
    timezone: normalized.cloak.timezone || undefined,
    headedInvisible: normalized.cloak.headedInvisible,
    platform: normalized.cloak.platform || undefined,
    stealthRuntimeFix: normalized.cloak.stealthRuntimeFix || undefined,
  });
}

// BetterWright methods a client may invoke, and where the session name pins
// into their arguments. `run(code, options)` is special-cased.
const SESSION_OPTION_METHODS = new Set([
  "fillCredential",
  "generateAndFillCredential",
  "commitGeneratedCredential",
  "discardGeneratedCredential",
  "listPendingCredentials",
  "startLiveView",
  "waitForHandoff",
  "waitForAsk",
]);
const PLAIN_METHODS = new Set([
  "stopLiveView",
  "liveViewStatus",
  "liveViewPostChat",
  "liveViewDrainChat",
]);

export function sessionName(value) {
  const name = String(value ?? "default").trim();
  return name || "default";
}

/**
 * Start the session daemon. Everything is injectable for tests; production
 * callers pass only `{home, config}` (see `runSessionDaemon`).
 *
 * @returns {Promise<{socketPath: string, close: () => Promise<void>}>}
 */
export async function startSessionDaemon(options = {}) {
  const home = options.home || defaultDaemonHome();
  const socketPath = options.socketPath || daemonSocketPath(home);
  const config = normalizeDaemonConfig(options.config);
  const configSig = JSON.stringify(config);
  const version = options.version || daemonPackageVersion();
  const ttlMs = Math.max(Number(options.ttlMs) || sessionTtlMs(), 1_000);
  const emptyGraceMs = Math.max(Number(options.emptyGraceMs) || EMPTY_GRACE_MS, 250);
  const reapIntervalMs = Math.max(Number(options.reapIntervalMs) || REAP_INTERVAL_MS, 50);
  const log =
    typeof options.log === "function"
      ? options.log
      : (line) => process.stderr.write(`${line}\n`);
  const onExit = typeof options.onExit === "function" ? options.onExit : null;

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const browser =
    typeof options.createBrowser === "function"
      ? options.createBrowser(config)
      : createBrowserFromDaemonConfig(config);

  /** @type {Map<string, {lastUsed: number, inflight: number, createdAt: number}>} */
  const sessions = new Map();
  // Per-session exec state: the agent's running transcript (in memory, with
  // the elided copy on disk), and a promise chain so two execs on the same
  // session can never interleave their conversations.
  const execHistories = new Map();
  const execChains = new Map();
  const connections = new Set();
  let lastTouch = Date.now();
  let shuttingDown = false;

  const touch = (name) => {
    lastTouch = Date.now();
    if (name === undefined) return null;
    const key = sessionName(name);
    let session = sessions.get(key);
    if (!session) {
      session = { lastUsed: Date.now(), inflight: 0, createdAt: Date.now() };
      sessions.set(key, session);
    }
    session.lastUsed = Date.now();
    return { key, session };
  };

  const sessionsPayload = () =>
    [...sessions.entries()].map(([name, session]) => ({
      name,
      idleMs: Math.max(0, Date.now() - session.lastUsed),
      inflight: session.inflight,
    }));

  const statusPayload = () => ({
    pid: process.pid,
    version,
    protocol: DAEMON_PROTOCOL,
    configSig,
    withVault: Boolean(browser.vault),
    ttlMs,
    sessions: sessionsPayload(),
  });

  async function closeOneSession(name) {
    const key = sessionName(name);
    const existed = sessions.delete(key);
    // The elided transcript stays on disk (like cookies do), so a later exec
    // in a re-created session still remembers past work; `exec --fresh` is
    // the explicit forget. The memory copy mirrors disk, so just drop it.
    execHistories.delete(key);
    let result = { ok: true, closed: false, pagesClosed: 0 };
    try {
      result = await browser.closeSession(key);
    } catch (error) {
      log(`session close failed for ${key}: ${error?.message || error}`);
    }
    return { ok: true, closed: Boolean(result?.closed) || existed, pagesClosed: result?.pagesClosed || 0 };
  }

  // One exec at a time per session; different sessions run concurrently.
  function runExecOp(message, emitStep) {
    const key = sessionName(message.session ?? "default");
    const prior = execChains.get(key) || Promise.resolve();
    const next = prior.then(() => execOne(key, message, emitStep));
    execChains.set(
      key,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  async function execOne(key, message, emitStep) {
    const tracked = touch(key);
    tracked.session.inflight += 1;
    try {
      // Lazy imports keep daemon startup light and avoid a module cycle with
      // session-store (which imports this file's path helpers). `runTask` is
      // injectable so tests can drive exec without a model or a browser.
      const runAgentTask =
        typeof options.runTask === "function"
          ? options.runTask
          : (await import("./agent.mjs")).runAgentTask;
      const store = await import("./session-store.mjs");
      if (message.fresh) {
        execHistories.delete(key);
        store.clearTranscript(home, key);
      }
      const history = message.fresh
        ? []
        : (execHistories.get(key) ?? store.loadTranscript(home, key));
      const result = await runAgentTask({
        task: String(message.task || ""),
        browser,
        session: key,
        history,
        model: message.model,
        modelOptions:
          message.modelOptions && typeof message.modelOptions === "object"
            ? message.modelOptions
            : {},
        ...(message.liveView !== undefined ? { liveView: message.liveView } : {}),
        onStep: (event) => {
          try {
            emitStep(event);
          } catch {
            /* a vanished viewer must never break the task */
          }
        },
      });
      execHistories.set(key, result.transcript);
      try {
        store.saveTranscript(home, key, result.transcript);
      } catch (error) {
        log(`transcript save failed for ${key}: ${error?.message || error}`);
      }
      const { transcript: _transcript, ...summary } = result;
      return { ...summary, session: key, resumedMessages: history.length };
    } finally {
      tracked.session.inflight = Math.max(0, tracked.session.inflight - 1);
      tracked.session.lastUsed = Date.now();
      lastTouch = Date.now();
    }
  }

  async function handleCall(message) {
    const method = String(message.method || "");
    const args = Array.isArray(message.args) ? message.args : [];
    const tracked = touch(message.session ?? "default");
    tracked.session.inflight += 1;
    try {
      if (method === "run") {
        const [code, runOptions] = args;
        return await browser.run(String(code ?? ""), {
          ...(runOptions && typeof runOptions === "object" ? runOptions : {}),
          session: tracked.key,
        });
      }
      if (SESSION_OPTION_METHODS.has(method)) {
        const [callOptions] = args;
        return await browser[method]({
          ...(callOptions && typeof callOptions === "object" ? callOptions : {}),
          session: tracked.key,
        });
      }
      if (PLAIN_METHODS.has(method)) {
        return await browser[method](...args.slice(0, 1));
      }
      throw new Error(`Unknown or disallowed method: ${method}`);
    } finally {
      tracked.session.inflight = Math.max(0, tracked.session.inflight - 1);
      tracked.session.lastUsed = Date.now();
      lastTouch = Date.now();
    }
  }

  let server;
  let reaper;

  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reaper);
    try {
      server?.close();
    } catch {
      /* already closed */
    }
    for (const socket of connections) socket.destroy();
    try {
      await browser.close();
    } catch {
      /* browser teardown is best effort */
    }
    for (const file of [socketPath, daemonInfoPath(home)]) {
      if (process.platform === "win32" && file === socketPath) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    }
    if (onExit) onExit(code);
    else process.exit(code);
  }

  function maybeShutdownWhenEmpty() {
    if (shuttingDown) return;
    const inflight = [...sessions.values()].some((s) => s.inflight > 0);
    if (inflight) return;
    if (sessions.size === 0 && Date.now() - lastTouch >= emptyGraceMs) {
      void shutdown(0);
    }
  }

  async function reap() {
    const cutoff = Date.now() - ttlMs;
    for (const [name, session] of sessions) {
      if (session.inflight > 0 || session.lastUsed >= cutoff) continue;
      await closeOneSession(name);
    }
    maybeShutdownWhenEmpty();
  }

  function handleConnection(socket) {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => socket.destroy());
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    // Readline re-emits input-stream errors on itself; a vanished client must
    // not take the daemon down with an uncaught exception.
    lines.on("error", () => {});
    const respond = (payload) => {
      if (socket.destroyed) return;
      try {
        // Callback form so a client that vanished mid-stream surfaces as a
        // swallowed write error, not an uncaught EPIPE in the daemon.
        socket.write(`${JSON.stringify(payload)}\n`, () => {});
      } catch {
        /* client went away */
      }
    };
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const id = message?.id;
      void (async () => {
        try {
          const op = String(message.op || "");
          if (op === "hello" || op === "status") {
            touch();
            respond({ id, ok: true, ...statusPayload() });
            return;
          }
          if (op === "call") {
            const result = await handleCall(message);
            respond({ id, ok: true, result });
            return;
          }
          if (op === "exec") {
            const result = await runExecOp(message, (step) =>
              respond({ id, ok: true, event: "step", step }),
            );
            respond({ id, ok: true, result });
            return;
          }
          if (op === "close_session") {
            touch();
            const outcome = await closeOneSession(message.session);
            respond({ id, ok: true, ...outcome });
            // The last explicit close ends the daemon promptly rather than
            // holding the profile (and a Chromium) for the empty-grace window.
            if (sessions.size === 0) {
              lastTouch = Date.now() - emptyGraceMs;
              setTimeout(() => maybeShutdownWhenEmpty(), 25).unref?.();
            }
            return;
          }
          if (op === "shutdown") {
            respond({ id, ok: true });
            setTimeout(() => void shutdown(0), 10);
            return;
          }
          respond({ id, ok: false, error: `Unknown daemon op: ${op}` });
        } catch (error) {
          respond({ id, ok: false, error: String(error?.message || error) });
        }
      })();
    });
  }

  server = net.createServer(handleConnection);
  await new Promise((resolve, reject) => {
    const tryListen = (retried) => {
      server.once("error", (error) => {
        if (error?.code !== "EADDRINUSE" || retried) {
          reject(error);
          return;
        }
        // Either another daemon is alive (we lost the spawn race — defer to
        // it) or a previous daemon died without unlinking its socket.
        const probe = net.connect(socketPath);
        probe.once("connect", () => {
          probe.destroy();
          reject(Object.assign(new Error("another session daemon is already running"), { code: "ALREADY_RUNNING" }));
        });
        probe.once("error", () => {
          probe.destroy();
          if (process.platform !== "win32") {
            try {
              fs.rmSync(socketPath, { force: true });
            } catch {
              /* fall through to the retry */
            }
          }
          tryListen(true);
        });
      });
      server.listen(socketPath, () => resolve());
    };
    tryListen(false);
  });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      /* the 0700 home directory is the outer gate */
    }
  }
  try {
    fs.writeFileSync(
      daemonInfoPath(home),
      JSON.stringify({
        pid: process.pid,
        socket: socketPath,
        version,
        configSig,
        startedAt: new Date().toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    /* informational only */
  }

  reaper = setInterval(() => void reap(), reapIntervalMs);
  reaper.unref?.();

  return {
    socketPath,
    close: () => shutdown(0),
  };
}

/**
 * Entry point for the hidden `betterwright __daemon` command: parse the
 * base64 config from argv, start the daemon, and stay alive until the empty
 * reaper or a signal ends the process.
 */
export async function runSessionDaemon(argv = process.argv) {
  process.title = "betterwright-daemon";
  const flagIndex = argv.indexOf("--config");
  let config = {};
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    try {
      config = JSON.parse(Buffer.from(argv[flagIndex + 1], "base64url").toString("utf8"));
    } catch {
      process.stderr.write("Invalid --config payload; starting with defaults.\n");
    }
  }
  let daemon;
  try {
    daemon = await startSessionDaemon({ config });
  } catch (error) {
    if (error?.code === "ALREADY_RUNNING") return 0;
    process.stderr.write(`${error?.stack || error}\n`);
    return 1;
  }
  const stop = () => void daemon.close();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("uncaughtException", (error) => {
    process.stderr.write(`daemon uncaught: ${error?.stack || error}\n`);
    void daemon.close();
  });
  // Stay alive until shutdown() calls process.exit.
  await new Promise(() => {});
  return 0;
}
