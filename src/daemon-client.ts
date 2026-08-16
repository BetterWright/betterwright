// Thin client for the BetterWright session daemon (src/daemon.ts).
//
// `acquireDaemonBrowser` is the one call the CLI uses: connect to the daemon
// for this home (spawning it detached when absent), verify version/config
// compatibility, and hand back a proxy object with the BetterWright surface
// the CLI and the exec harness drive (`run`, credential fills, live view,
// handoff/ask waits). Every proxy method resolves an `{ok:false, error}`
// envelope on transport failure — the same no-throw contract BetterWright's
// own methods keep — so callers never need daemon-specific error handling.
//
// When the daemon cannot be used (spawn failed, or it is busy with sessions
// under a different config), the caller falls back to a private in-process
// BetterWright: exactly the pre-daemon behavior.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";

import {
  daemonConfigSignature,
  daemonLogPath,
  daemonPackageVersion,
  daemonSocketPath,
  defaultDaemonHome,
  sessionName,
} from "./daemon.js";
import { profileLabel, resolveProfileName } from "./profile-name.js";
import type { UntrustedValue } from "./untrusted-value.js";

const CONNECT_TIMEOUT_MS = 1_000;
const SPAWN_WAIT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
// Probe a freshly spawned daemon eagerly, then back off to the steady interval.
// The deadline (SPAWN_WAIT_MS) is what bounds the wait; these only decide how
// much of it a fast start has to sit through.
const SPAWN_RETRY_MIN_MS = 25;
const SPAWN_RETRY_MAX_MS = 100;
// The daemon's stderr log is append-only across restarts; roll it over once it
// gets large so a long-lived install cannot fill a disk with it.
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;
// How long `execTask` keeps trying to get back to a run whose connection
// dropped, and how long it waits between attempts.
const REATTACH_WINDOW_MS = 30_000;
const REATTACH_INTERVAL_MS = 500;

export function daemonDisabled(flags = new Set()) {
  if (flags.has("--no-daemon")) return true;
  return ["1", "true", "yes", "on"].includes(
    String(process.env.BETTERWRIGHT_NO_DAEMON || "").trim().toLowerCase(),
  );
}

function connectOnce(socketPath, timeoutMs = CONNECT_TIMEOUT_MS): Promise<any> {
  return new Promise<any>((resolve) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Wrap a connected socket in an id-multiplexed request channel. */
function createChannel(socket): any {
  let nextId = 1;
  const pending = new Map();
  let closed = false;
  const failAll = (reason) => {
    closed = true;
    for (const [, entry] of pending) entry.reject(new Error(reason));
    pending.clear();
  };
  readline
    .createInterface({ input: socket, crlfDelay: Infinity })
    // Readline re-emits input-stream errors (e.g. EPIPE after the daemon
    // died) on itself; without a handler that becomes an uncaught exception.
    .on("error", () => {})
    .on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const entry = pending.get(message?.id);
      if (!entry) return;
      // Streamed interim events (the run id, step notes, a replay gap) keep
      // the request pending; the final message — the one without `event` —
      // settles it. The whole frame goes to the listener, because the run id
      // and sequence number on it are what make a reattach possible.
      if (message.event) {
        try {
          entry.onEvent?.(message);
        } catch {
          /* a broken step renderer must not kill the request */
        }
        return;
      }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    });
  socket.on("close", () => failAll("the session daemon connection closed"));
  socket.on("error", () => socket.destroy());
  return {
    socket,
    request(payload, timeoutMs = 0, onEvent) {
      if (closed || socket.destroyed)
        return Promise.reject(new Error("the session daemon connection closed"));
      const id = nextId++;
      return new Promise<any>((resolve, reject) => {
        const entry = { resolve, reject, timer: null, onEvent };
        if (timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`the session daemon did not answer within ${timeoutMs}ms`));
          }, timeoutMs);
          entry.timer.unref?.();
        }
        pending.set(id, entry);
        const fail = (error) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          reject(error);
        };
        try {
          // The callback form keeps a dead socket's EPIPE out of the process
          // as an uncaught exception — it rejects this request instead.
          socket.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
            if (error) fail(error);
          });
        } catch (error) {
          fail(error);
        }
      });
    },
    end() {
      closed = true;
      try {
        socket.end();
      } catch {
        /* already gone */
      }
      socket.destroy();
    },
  };
}

/** Keep one previous generation of the daemon log, drop anything older. */
function rotateDaemonLog(file) {
  try {
    if (fs.statSync(file).size < LOG_ROTATE_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* no log yet, or a rename we are not allowed to do — either is fine */
  }
}

function spawnDaemon({ home, cliPath, config, profile }) {
  const payload = Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
  let logFd: number | "ignore";
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // One log per daemon, so two profiles' daemons never interleave lines in
    // one file and `daemon-<name>.log` names the identity that wrote it.
    rotateDaemonLog(daemonLogPath(home, profile));
    logFd = fs.openSync(daemonLogPath(home, profile), "a", 0o600);
  } catch {
    logFd = "ignore";
  }
  const child = spawn(
    process.execPath,
    [cliPath, "__daemon", "--config", payload],
    {
      detached: true,
      stdio: ["ignore", "ignore", logFd],
      // Pin the daemon's home to the one the client resolved. The daemon
      // otherwise reads BETTERWRIGHT_HOME itself, so a programmatic
      // `connectSessionDaemon({home})` that did not also set the env var would
      // spawn a daemon on the *default* socket while the client waits on the
      // custom one — they must agree on which home, hence which socket.
      env: { ...process.env, BETTERWRIGHT_HOME: home, NODE_NO_WARNINGS: "1" },
    },
  );
  child.unref();
  if (logFd !== "ignore") {
    try {
      fs.closeSync(logFd);
    } catch {
      /* the child holds its own descriptor */
    }
  }
}

async function connectWithSpawn({ home, socketPath, cliPath, config, profile, spawnIfNeeded }) {
  let socket = await connectOnce(socketPath);
  if (socket || !spawnIfNeeded) return socket;
  // A dead daemon can leave its socket file behind; remove it so the fresh
  // daemon can bind (the daemon double-checks against a live listener itself).
  if (process.platform !== "win32" && fs.existsSync(socketPath)) {
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      /* the daemon's own EADDRINUSE probe handles this */
    }
  }
  spawnDaemon({ home, cliPath, config, profile });
  const deadline = Date.now() + SPAWN_WAIT_MS;
  let retryMs = SPAWN_RETRY_MIN_MS;
  while (Date.now() < deadline) {
    socket = await connectOnce(socketPath, 500);
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    retryMs = Math.min(retryMs * 2, SPAWN_RETRY_MAX_MS);
  }
  return null;
}

async function waitForSocketGone(socketPath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await connectOnce(socketPath, 300);
    if (!socket) return true;
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Connect to (or start) the session daemon and complete the hello handshake.
 *
 * @returns {Promise<
 *   | {ok: true, channel: ReturnType<typeof createChannel>, hello: object}
 *   | {ok: false, reason: string}
 * >}
 */
export async function connectSessionDaemon({
  home = defaultDaemonHome(),
  cliPath,
  config = {},
  spawnIfNeeded = true,
  // Management commands (`close`, `sessions`) talk to whatever daemon is
  // there, regardless of version/config — they only inspect and tear down.
  ignoreMismatch = false,
  // Which identity's daemon to talk to. Each profile has its own socket, so
  // this selects a *different daemon* rather than reconfiguring a shared one:
  // two profiles keep their sessions alive side by side. Defaults to the
  // profile in `config`, which is where the CLI puts it.
  profile = undefined,
  _retried = false,
}: any = {}): Promise<any> {
  const wantProfile = resolveProfileName(profile ?? config?.profile);
  const socketPath = daemonSocketPath(home, wantProfile);
  const version = daemonPackageVersion();
  const configSig = daemonConfigSignature({ ...config, profile: wantProfile });
  const socket = await connectWithSpawn({
    home,
    socketPath,
    cliPath,
    config: { ...config, profile: wantProfile },
    profile: wantProfile,
    spawnIfNeeded,
  });
  if (!socket) {
    return {
      ok: false,
      reason: spawnIfNeeded
        ? `the session daemon for profile ${profileLabel(wantProfile)} did not start`
        : `no session daemon is running for profile ${profileLabel(wantProfile)}`,
    };
  }
  const channel = createChannel(socket);
  let hello;
  try {
    hello = await channel.request({ op: "hello", version, configSig }, HANDSHAKE_TIMEOUT_MS);
  } catch (error) {
    channel.end();
    return { ok: false, reason: String(error?.message || error) };
  }
  if (!hello?.ok) {
    channel.end();
    return { ok: false, reason: hello?.error || "the session daemon rejected the handshake" };
  }
  if (ignoreMismatch || (hello.version === version && hello.configSig === configSig)) {
    return { ok: true, channel, hello };
  }
  // Mismatched daemon (older package, or different policy/browser flags).
  // Idle: replace it. Holding live sessions: leave it alone and let the
  // caller fall back to a private one-shot browser.
  const sessions = Array.isArray(hello.sessions) ? hello.sessions : [];
  const busy = sessions.length > 0;
  if (busy || _retried || !spawnIfNeeded) {
    channel.end();
    const what =
      hello.version !== version
        ? `version ${hello.version}`
        : // The socket is per profile, so a profile mismatch here means a
          // daemon from before this feature (or a hand-built config); name it
          // precisely rather than blaming "flags" the user did not pass.
          (hello.profile ?? null) !== wantProfile
          ? `profile ${profileLabel(hello.profile ?? null)}`
          : "different browser flags";
    return {
      ok: false,
      reason:
        `a session daemon with ${what} is holding ${sessions.length} live session(s); ` +
        "using a one-shot browser for this call (close them with `betterwright close --all` to switch)",
    };
  }
  try {
    await channel.request({ op: "shutdown" }, HANDSHAKE_TIMEOUT_MS);
  } catch {
    /* it may exit before answering */
  }
  channel.end();
  await waitForSocketGone(socketPath);
  return connectSessionDaemon({
    home,
    cliPath,
    config,
    profile: wantProfile,
    spawnIfNeeded,
    _retried: true,
  });
}

/**
 * A minimal BetterWright-shaped proxy over a daemon channel, pinned to one
 * session — what `betterwright run`/`repl` drive. Snippets run in the
 * daemon's browser; transport failures resolve as `{ok:false, error}`
 * envelopes (the same no-throw contract BetterWright.run keeps). `close()`
 * only disconnects — the session (tabs, state, logins) stays alive.
 */
export function createDaemonBrowser(channel, { session = "default" }: any = {}) {
  const pinned = sessionName(session);
  const call = async (method, args = [], timeoutMs = 60_000) => {
    let reply;
    try {
      reply = await channel.request(
        {
          op: "call",
          method,
          args,
          session: pinned,
        },
        timeoutMs,
      );
    } catch (error) {
      return { ok: false, error: `session daemon: ${error?.message || error}` };
    }
    if (!reply?.ok) return { ok: false, error: reply?.error || "session daemon call failed" };
    return reply.result;
  };
  return {
    session: pinned,
    run: (code, options?: any) => call("run", [code, options]),
    // Live view is host-side only (sealed from run snippets). Exposing these
    // on the daemon proxy lets `betterwright view` attach mid-session to the
    // same browser tabs that `run`/`exec` already use.
    startLiveView: (options) => call("startLiveView", [options], 30_000),
    stopLiveView: () => call("stopLiveView", [], 30_000),
    liveViewStatus: () => call("liveViewStatus", [], 30_000),
    liveViewPostChat: (options) => call("liveViewPostChat", [options], 30_000),
    liveViewDrainChat: () => call("liveViewDrainChat", [], 30_000),
    waitForHandoff: (options) => call("waitForHandoff", [options], 0),
    waitForAsk: (options) => call("waitForAsk", [options], 0),
    closeSession: () => channel.request({ op: "close_session", session: pinned }, 60_000),
    close: async () => channel.end(),
  };
}

/** Ask the daemon to stop a session's run at the next safe point. */
export async function interruptSession(channel, session, { wait = true }: any = {}) {
  try {
    const reply = await channel.request(
      { op: "interrupt", session: sessionName(session), wait },
      wait ? 0 : 10_000,
    );
    return Boolean(reply?.interrupted);
  } catch {
    return false;
  }
}

/**
 * Run one agent task inside the daemon: the LLM loop lives there, so its
 * transcript and browser session persist across CLI invocations. Step events
 * stream to `onStep` as they happen; resolves with the run summary (no
 * transcript — that stays with the daemon).
 *
 * The run belongs to the daemon, not to this connection. If the connection
 * drops mid-run and `reconnect` is supplied, this reattaches to the same run
 * and replays the steps it missed, so a flaky pipe costs a moment rather than
 * the whole task. `onNotice` hears about those recoveries.
 */
export async function execTask(
  channel,
  payload,
  {
    onStep,
    onNotice,
    reconnect,
  }: {
    onStep?: (step: UntrustedValue) => void;
    onNotice?: (notice: string) => void;
    reconnect?: () => Promise<any> | any;
  } = {},
) {
  const session = sessionName(payload.session ?? "default");
  const step = onStep ?? (() => {});
  const notice = onNotice ?? (() => {});
  let runId = null;
  let cursor = null;

  // One listener for both the original exec and any reattach: it keeps the
  // cursor current, which is the only state a reattach needs.
  const onEvent = (frame) => {
    if (frame.event === "run") {
      runId = frame.runId || runId;
      return;
    }
    if (frame.event === "gap") {
      notice(
        `reconnected mid-run, but ${frame.firstSeq - (cursor?.seq ?? 0) - 1} step note(s) had already scrolled out of the daemon's buffer`,
      );
      return;
    }
    if (frame.event !== "step") return;
    if (frame.runId) runId = frame.runId;
    if (Number.isFinite(frame.seq)) cursor = { runId: frame.runId, seq: frame.seq };
    step(frame.step);
  };

  let reply;
  try {
    reply = await channel.request({ op: "exec", ...payload }, 0, onEvent);
  } catch (error) {
    if (!reconnect) throw error;
    reply = await reattach({ session, runId, cursor, onEvent, reconnect, notice, cause: error });
  }
  if (!reply?.ok) throw new Error(reply?.error || "the session daemon exec failed");
  return reply.result;
}

/**
 * Get back to a run whose connection died. Retries for a bounded window
 * because the usual cause — the daemon restarting a wedged worker, a pipe
 * hiccup — resolves in under a second.
 */
async function reattach({ session, runId, cursor, onEvent, reconnect, notice, cause }) {
  const deadline = Date.now() + REATTACH_WINDOW_MS;
  let last = cause;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, REATTACH_INTERVAL_MS));
    let channel;
    try {
      channel = await reconnect();
    } catch (error) {
      last = error;
      continue;
    }
    if (!channel) continue;
    notice("lost the connection to the session daemon; reattaching to the run");
    try {
      return await channel.request({ op: "attach", session, runId, cursor }, 0, onEvent);
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
