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
//                                              withVault, sessions, startedAt,
//                                              uptimeMs, runs}
//   call          {method, args, session}  -> {ok, result} for a whitelisted
//                                             BetterWright method; the daemon
//                                             pins `session` into the options
//   exec          {task, model, modelOptions, session, fresh?, liveView?}
//                                          -> streamed `{id, ok, event:"step",
//                                             runId, seq, step}` frames while
//                                             the agent works, then a final
//                                             `{id, ok, result}` summary. The
//                                             agent loop (src/agent.mjs) runs
//                                             HERE, in the daemon, so its
//                                             conversation history and browser
//                                             session both live across CLI
//                                             invocations; history is also
//                                             persisted (elided) to disk via
//                                             src/session-store.mjs so resume
//                                             survives a daemon restart.
//   attach        {session, cursor?}       -> re-subscribe to the session's
//                                             in-flight (or just-finished) run
//                                             and replay the frames missed
//                                             since `cursor` ({runId, seq}),
//                                             then stream live and deliver the
//                                             same final summary. This is what
//                                             makes a dropped connection a
//                                             cosmetic event rather than a lost
//                                             run.
//   interrupt     {session}                -> {ok, interrupted} — stop the
//                                             session's run at the next safe
//                                             point; the transcript is kept
//   close_session {session}                -> {ok, closed, pagesClosed}
//   status        {}                        -> same payload as hello
//   shutdown      {}                        -> {ok}, then the daemon exits
//
// Auth model: filesystem permissions (socket 0600 inside the 0700 home), the
// ssh-agent shape — same-user processes only. Sessions are collaboration
// scopes, not a security boundary.
//
// Lifecycle: sessions idle out after BETTERWRIGHT_SESSION_TTL_SECONDS
// (default 900); the daemon exits on its own once no sessions remain. A run
// whose last subscriber vanishes is interrupted after
// BETTERWRIGHT_ORPHAN_GRACE_SECONDS (default 30, 0 disables) so a killed
// terminal cannot leave an agent burning tokens unattended.

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { BetterWright, NetworkPolicy } from "./client.mjs";

const require = createRequire(import.meta.url);

export const DAEMON_PROTOCOL = 2;
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MIN_SESSION_TTL_MS = 30_000;
const EMPTY_GRACE_MS = 60_000;
const REAP_INTERVAL_MS = 15_000;
// How long a run survives with nobody watching before it is interrupted. The
// CLI sends an explicit `interrupt` on Ctrl-C; this is the backstop for the
// hard kills (closed terminal, SIGKILL) that never get to send anything.
export const DEFAULT_ORPHAN_GRACE_MS = 30_000;
// Frames kept per run for replay after a reconnect. A step frame is a short
// note, so this is kilobytes, and it bounds what one wedged reader can cost.
const REPLAY_BUFFER_FRAMES = 512;
// A finished run stays available this long so a client that reconnects just
// after the agent stopped still collects its answer instead of a bare error.
const FINISHED_RUN_RETENTION_MS = 60_000;
// One request line cannot exceed this. Same-user clients are trusted, but a
// buggy one must not be able to grow the daemon's heap without bound.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
// A subscriber that stops reading is dropped once this much unwritten data has
// piled up in its socket, rather than buffering it in the daemon forever.
const MAX_SOCKET_BACKLOG_BYTES = 8 * 1024 * 1024;
// Teardown gets this long to finish before the process exits anyway. A wedged
// Chromium must never leave a daemon holding an unreachable socket.
const SHUTDOWN_DEADLINE_MS = 10_000;

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

export function daemonLogPath(home = defaultDaemonHome()) {
  return path.join(home, "daemon.log");
}

export function sessionTtlMs() {
  const raw = Number(process.env.BETTERWRIGHT_SESSION_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_TTL_MS;
  return Math.max(raw * 1000, MIN_SESSION_TTL_MS);
}

export function orphanGraceMs() {
  const raw = process.env.BETTERWRIGHT_ORPHAN_GRACE_SECONDS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_ORPHAN_GRACE_MS;
  const seconds = Number(raw);
  // 0 is meaningful: let a detached run finish on its own.
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_ORPHAN_GRACE_MS;
  return seconds * 1000;
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
 * A bounded ring of run frames, replayable from a cursor.
 *
 * A reconnecting client says "I last saw seq N of run R"; this answers with
 * everything after it, or reports a `gap` when the frames it missed have
 * already rolled out of the ring — a client that is told it missed steps can
 * say so, which is strictly better than silently resuming mid-story.
 */
export class ReplayBuffer {
  constructor(limit = REPLAY_BUFFER_FRAMES) {
    this.limit = Math.max(1, limit);
    this.frames = [];
  }

  clear() {
    this.frames.length = 0;
  }

  append(frame) {
    this.frames.push(frame);
    if (this.frames.length > this.limit) this.frames.shift();
  }

  /** @returns {{kind: "frames", frames: object[]} | {kind: "gap", firstSeq: number}} */
  since(cursor) {
    if (!cursor || typeof cursor !== "object") return { kind: "frames", frames: [...this.frames] };
    const { runId, seq } = cursor;
    // A cursor from an older run tells us nothing about this one — replay all.
    if (!runId || !this.frames.length || this.frames[0].runId !== runId)
      return { kind: "frames", frames: [...this.frames] };
    const wanted = Number(seq);
    if (!Number.isFinite(wanted)) return { kind: "frames", frames: [...this.frames] };
    const firstSeq = this.frames[0].seq;
    // The next frame the client needs is wanted+1; if the ring already starts
    // past it, the intervening frames are gone.
    if (wanted + 1 < firstSeq) return { kind: "gap", firstSeq };
    return { kind: "frames", frames: this.frames.filter((frame) => frame.seq > wanted) };
  }
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
  const graceMs = options.orphanGraceMs === undefined ? orphanGraceMs() : Number(options.orphanGraceMs);
  const retentionMs =
    options.finishedRunRetentionMs === undefined
      ? FINISHED_RUN_RETENTION_MS
      : Math.max(0, Number(options.finishedRunRetentionMs));
  const log =
    typeof options.log === "function"
      ? options.log
      : (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const onExit = typeof options.onExit === "function" ? options.onExit : null;
  const startedAt = Date.now();

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
  // Per-session run record: the live (or just-finished) agent run, its frame
  // ring, its subscribers, and the controller that stops it.
  /** @type {Map<string, object>} */
  const runs = new Map();
  const connections = new Set();
  let lastTouch = Date.now();
  let shuttingDown = false;
  let runsStarted = 0;

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
    [...sessions.entries()].map(([name, session]) => {
      const run = runs.get(name);
      return {
        name,
        idleMs: Math.max(0, Date.now() - session.lastUsed),
        createdAt: new Date(session.createdAt).toISOString(),
        inflight: session.inflight,
        running: Boolean(run && !run.settled),
        watchers: run ? run.subscribers.size : 0,
      };
    });

  const statusPayload = () => ({
    pid: process.pid,
    version,
    protocol: DAEMON_PROTOCOL,
    configSig,
    withVault: Boolean(browser.vault),
    ttlMs,
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Date.now() - startedAt,
    runs: { started: runsStarted, active: [...runs.values()].filter((run) => !run.settled).length },
    sessions: sessionsPayload(),
  });

  // ---- run registry -------------------------------------------------------

  function dropSubscriber(run, subscriber) {
    if (!run.subscribers.delete(subscriber)) return;
    armOrphanTimer(run);
  }

  // Nobody is watching a live run: give a reconnect a window, then stop it.
  function armOrphanTimer(run) {
    if (run.orphanTimer) {
      clearTimeout(run.orphanTimer);
      run.orphanTimer = null;
    }
    if (run.settled || run.subscribers.size > 0 || !(graceMs > 0)) return;
    run.orphanTimer = setTimeout(() => {
      run.orphanTimer = null;
      if (run.settled || run.subscribers.size > 0) return;
      log(`run ${run.runId} (session ${run.session}) lost its last watcher; interrupting`);
      run.controller.abort();
    }, graceMs);
    run.orphanTimer.unref?.();
  }

  function addSubscriber(run, subscriber) {
    run.subscribers.add(subscriber);
    if (run.orphanTimer) {
      clearTimeout(run.orphanTimer);
      run.orphanTimer = null;
    }
  }

  function emitFrame(run, step) {
    run.seq += 1;
    const frame = { runId: run.runId, seq: run.seq, step };
    run.buffer.append(frame);
    for (const subscriber of [...run.subscribers]) {
      if (!subscriber.send({ id: subscriber.id, ok: true, event: "step", ...frame }))
        dropSubscriber(run, subscriber);
    }
  }

  function settleRun(run, payload) {
    run.settled = payload;
    run.settledAt = Date.now();
    if (run.orphanTimer) {
      clearTimeout(run.orphanTimer);
      run.orphanTimer = null;
    }
    for (const subscriber of [...run.subscribers])
      subscriber.send({ id: subscriber.id, ...payload });
    run.subscribers.clear();
  }

  // Hand a subscriber everything it has not seen. Returns false when the
  // subscriber's socket died on the way, so the caller can forget it.
  function catchUp(run, subscriber, cursor) {
    const replay = run.buffer.since(cursor);
    if (replay.kind === "gap") {
      if (
        !subscriber.send({
          id: subscriber.id,
          ok: true,
          event: "gap",
          runId: run.runId,
          firstSeq: replay.firstSeq,
        })
      )
        return false;
      for (const frame of run.buffer.frames)
        if (!subscriber.send({ id: subscriber.id, ok: true, event: "step", ...frame })) return false;
      return true;
    }
    for (const frame of replay.frames)
      if (!subscriber.send({ id: subscriber.id, ok: true, event: "step", ...frame })) return false;
    return true;
  }

  function forgetRunIfExpired(key) {
    const run = runs.get(key);
    if (!run?.settled) return;
    if (Date.now() - run.settledAt < retentionMs) return;
    runs.delete(key);
  }

  /** Stop a session's run and wait for the agent loop to unwind. */
  async function interruptSession(key, { wait = true } = {}) {
    const run = runs.get(key);
    if (!run || run.settled) return false;
    run.controller.abort();
    if (wait) await run.promise.catch(() => {});
    return true;
  }

  async function closeOneSession(name) {
    const key = sessionName(name);
    // Never pull the pages out from under a running agent: stop it first and
    // let it unwind, the way an explicit `interrupt` would.
    await interruptSession(key);
    const existed = sessions.delete(key);
    // The elided transcript stays on disk (like cookies do), so a later exec
    // in a re-created session still remembers past work; `exec --fresh` is
    // the explicit forget. The memory copy mirrors disk, so just drop it.
    execHistories.delete(key);
    execChains.delete(key);
    runs.delete(key);
    let result = { ok: true, closed: false, pagesClosed: 0 };
    try {
      result = await browser.closeSession(key);
    } catch (error) {
      log(`session close failed for ${key}: ${error?.message || error}`);
    }
    return { ok: true, closed: Boolean(result?.closed) || existed, pagesClosed: result?.pagesClosed || 0 };
  }

  // One exec at a time per session; different sessions run concurrently.
  function runExecOp(message, subscriber) {
    const key = sessionName(message.session ?? "default");
    const prior = execChains.get(key) || Promise.resolve();
    const next = prior.then(() => execOne(key, message, subscriber));
    const chained = next.then(
      () => {},
      () => {},
    );
    execChains.set(key, chained);
    // Keep the map from growing one dead promise per session name forever.
    void chained.then(() => {
      if (execChains.get(key) === chained) execChains.delete(key);
    });
    return next;
  }

  async function execOne(key, message, subscriber) {
    const tracked = touch(key);
    tracked.session.inflight += 1;
    const controller = new AbortController();
    const run = {
      session: key,
      runId: crypto.randomUUID(),
      seq: 0,
      buffer: new ReplayBuffer(REPLAY_BUFFER_FRAMES),
      subscribers: new Set(),
      controller,
      settled: null,
      settledAt: 0,
      orphanTimer: null,
      promise: null,
      startedAt: Date.now(),
    };
    runs.set(key, run);
    runsStarted += 1;
    if (subscriber) addSubscriber(run, subscriber);
    else armOrphanTimer(run);
    // Announce the run id before any step, so a client that drops immediately
    // still has a cursor to reattach with.
    subscriber?.send({ id: subscriber.id, ok: true, event: "run", runId: run.runId, session: key });

    const body = (async () => {
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
        signal: controller.signal,
        ...(message.liveView !== undefined ? { liveView: message.liveView } : {}),
        onStep: (event) => {
          try {
            emitFrame(run, event);
          } catch {
            /* a vanished viewer must never break the task */
          }
        },
      });
      // Persist even an interrupted transcript: the whole point of stopping a
      // run is to pick it back up.
      if (result.transcript) {
        execHistories.set(key, result.transcript);
        try {
          store.saveTranscript(home, key, result.transcript);
        } catch (error) {
          log(`transcript save failed for ${key}: ${error?.message || error}`);
        }
      }
      const { transcript: _transcript, ...summary } = result;
      return { ...summary, session: key, runId: run.runId, resumedMessages: history.length };
    })();

    run.promise = body;
    try {
      const result = await body;
      settleRun(run, { ok: true, result });
      return result;
    } catch (error) {
      const payload = { ok: false, error: String(error?.message || error) };
      settleRun(run, payload);
      throw error;
    } finally {
      tracked.session.inflight = Math.max(0, tracked.session.inflight - 1);
      tracked.session.lastUsed = Date.now();
      lastTouch = Date.now();
    }
  }

  /**
   * Re-subscribe to a session's run. Resolves with the run's final payload,
   * exactly as the original `exec` request would have.
   */
  function attachToRun(message, subscriber) {
    const key = sessionName(message.session ?? "default");
    const run = runs.get(key);
    if (!run) return { ok: false, error: `no run to attach to on session "${key}"` };
    if (message.runId && message.runId !== run.runId)
      return { ok: false, error: `run ${message.runId} is no longer available on session "${key}"` };
    touch(key);
    if (!catchUp(run, subscriber, message.cursor)) return { ok: false, error: "the client went away" };
    // Already finished: hand over the stored answer instead of a subscription.
    if (run.settled) return run.settled;
    addSubscriber(run, subscriber);
    return null; // the run settles it later
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
    // Teardown must not be able to wedge the process: whatever happens below,
    // the daemon is gone within SHUTDOWN_DEADLINE_MS. Removing the socket
    // first means a client that arrives during teardown starts a fresh daemon
    // instead of connecting to one that is on its way out.
    // Deliberately not unref'd. This watchdog exists to guarantee the process
    // ends on our terms, and an unref'd timer cannot promise that: once the
    // server and its sockets are gone, nothing else holds the loop, so Node
    // would drain and exit 0 on its own — turning a crash shutdown into a
    // silent success. `clearTimeout` below keeps it from adding any delay to
    // a teardown that finishes normally.
    const failsafe = setTimeout(() => {
      if (onExit) onExit(code);
      else process.exit(code);
    }, SHUTDOWN_DEADLINE_MS);
    try {
      server?.close();
    } catch {
      /* already closed */
    }
    for (const run of runs.values()) {
      if (run.orphanTimer) clearTimeout(run.orphanTimer);
      if (!run.settled) run.controller.abort();
    }
    for (const file of [socketPath, daemonInfoPath(home)]) {
      if (process.platform === "win32" && file === socketPath) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    }
    for (const socket of connections) socket.destroy();
    try {
      await browser.close();
    } catch {
      /* browser teardown is best effort */
    }
    clearTimeout(failsafe);
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
    for (const key of [...runs.keys()]) forgetRunIfExpired(key);
    for (const [name, session] of sessions) {
      if (session.inflight > 0 || session.lastUsed >= cutoff) continue;
      await closeOneSession(name);
    }
    maybeShutdownWhenEmpty();
  }

  function handleConnection(socket) {
    connections.add(socket);
    // Release this connection's subscriptions the moment it goes away, rather
    // than discovering they are dead at the next broadcast — that is what
    // starts the orphan timer while there is still time to reattach.
    const release = () => {
      connections.delete(socket);
      for (const run of runs.values())
        for (const subscriber of [...run.subscribers])
          if (subscriber.socket === socket) dropSubscriber(run, subscriber);
    };
    socket.on("close", release);
    socket.on("error", () => socket.destroy());

    const respond = (payload) => {
      if (socket.destroyed) return false;
      // A client that stopped reading must not be able to grow the daemon's
      // heap: past the backlog ceiling it is disconnected, and its run's
      // orphan timer takes over from there.
      if (socket.writableLength > MAX_SOCKET_BACKLOG_BYTES) {
        log("dropping a subscriber that stopped reading");
        socket.destroy();
        return false;
      }
      try {
        // Callback form so a client that vanished mid-stream surfaces as a
        // swallowed write error, not an uncaught EPIPE in the daemon.
        socket.write(`${JSON.stringify(payload)}\n`, () => {});
        return true;
      } catch {
        return false; /* client went away */
      }
    };

    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    // Readline re-emits input-stream errors on itself; a vanished client must
    // not take the daemon down with an uncaught exception.
    lines.on("error", () => {});
    lines.on("line", (line) => {
      if (line.length > MAX_REQUEST_BYTES) {
        respond({ id: null, ok: false, error: "request too large" });
        socket.destroy();
        return;
      }
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
            // `settleRun` answers this request through the subscriber, so the
            // originating client and a later reattach take the same path —
            // including the failure envelope, hence the swallow here.
            await runExecOp(message, { id, send: respond, socket }).catch(() => {});
            return;
          }
          if (op === "attach") {
            const settled = attachToRun(message, { id, send: respond, socket });
            // A live run answers later, through its subscriber list.
            if (settled) respond({ id, ...settled });
            return;
          }
          if (op === "interrupt") {
            touch(message.session ?? "default");
            const interrupted = await interruptSession(sessionName(message.session ?? "default"), {
              wait: message.wait !== false,
            });
            respond({ id, ok: true, interrupted });
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
        protocol: DAEMON_PROTOCOL,
        configSig,
        startedAt: new Date(startedAt).toISOString(),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    /* informational only */
  }

  reaper = setInterval(() => void reap(), reapIntervalMs);
  reaper.unref?.();
  log(`listening on ${socketPath} (pid ${process.pid}, v${version}, protocol ${DAEMON_PROTOCOL})`);

  return {
    socketPath,
    // The code matters: the crash handler passes 1 so a supervisor and the log
    // agree that this was a failure, not a clean stop.
    close: (code = 0) => shutdown(code),
    // Exposed for tests and for the signal handlers below.
    _internals: { runs, sessions, statusPayload },
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
  // A stray rejection is a bug, not a reason to take every live session with
  // it. Log it and keep serving; the per-op try/catch already answers the
  // request that caused it. Without this handler Node turns the rejection
  // into an uncaught exception and the daemon dies mid-run.
  process.on("unhandledRejection", (error) => {
    process.stderr.write(
      `${new Date().toISOString()} daemon unhandled rejection: ${error?.stack || error}\n`,
    );
  });
  // An uncaught exception leaves the process in an unknown state, so this one
  // does end the daemon — but gracefully (browser closed, socket unlinked)
  // and with a failure code, so a supervisor and the log agree on what
  // happened.
  process.on("uncaughtException", (error) => {
    process.stderr.write(`${new Date().toISOString()} daemon uncaught: ${error?.stack || error}\n`);
    void daemon.close(1);
  });
  // Stay alive until shutdown() calls process.exit.
  await new Promise(() => {});
  return 0;
}
