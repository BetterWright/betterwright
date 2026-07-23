// Thin client for the BetterWright session daemon (src/daemon.mjs).
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
import path from "node:path";
import readline from "node:readline";

import {
  daemonConfigSignature,
  daemonPackageVersion,
  daemonSocketPath,
  defaultDaemonHome,
  sessionName,
} from "./daemon.mjs";

const CONNECT_TIMEOUT_MS = 1_000;
const SPAWN_WAIT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export function daemonDisabled(flags = new Set()) {
  if (flags.has("--no-daemon")) return true;
  return ["1", "true", "yes", "on"].includes(
    String(process.env.BETTERWRIGHT_NO_DAEMON || "").trim().toLowerCase(),
  );
}

function connectOnce(socketPath, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
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
function createChannel(socket) {
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
      // Streamed interim events (exec step notes) keep the request pending;
      // the final message — the one without `event` — settles it.
      if (message.event === "step") {
        try {
          entry.onEvent?.(message.step);
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
      return new Promise((resolve, reject) => {
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

function spawnDaemon({ home, cliPath, config }) {
  const payload = Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
  let logFd;
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    logFd = fs.openSync(path.join(home, "daemon.log"), "a", 0o600);
  } catch {
    logFd = "ignore";
  }
  const child = spawn(
    process.execPath,
    [cliPath, "__daemon", "--config", payload],
    {
      detached: true,
      stdio: ["ignore", "ignore", logFd],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  child.unref();
  if (typeof logFd === "number") {
    try {
      fs.closeSync(logFd);
    } catch {
      /* the child holds its own descriptor */
    }
  }
}

async function connectWithSpawn({ home, socketPath, cliPath, config, spawnIfNeeded }) {
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
  spawnDaemon({ home, cliPath, config });
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket = await connectOnce(socketPath, 500);
    if (socket) return socket;
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
  _retried = false,
} = {}) {
  const socketPath = daemonSocketPath(home);
  const version = daemonPackageVersion();
  const configSig = daemonConfigSignature(config);
  const socket = await connectWithSpawn({ home, socketPath, cliPath, config, spawnIfNeeded });
  if (!socket) {
    return {
      ok: false,
      reason: spawnIfNeeded
        ? "the session daemon did not start"
        : "no session daemon is running",
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
  // Mismatched daemon (older package, or different policy/cloaking flags).
  // Idle: replace it. Holding live sessions: leave it alone and let the
  // caller fall back to a private one-shot browser.
  const sessions = Array.isArray(hello.sessions) ? hello.sessions : [];
  const busy = sessions.length > 0;
  if (busy || _retried || !spawnIfNeeded) {
    channel.end();
    const what = hello.version === version ? "different browser flags" : `version ${hello.version}`;
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
  return connectSessionDaemon({ home, cliPath, config, spawnIfNeeded, _retried: true });
}

/**
 * A minimal BetterWright-shaped proxy over a daemon channel, pinned to one
 * session — what `betterwright run`/`repl` drive. Snippets run in the
 * daemon's browser; transport failures resolve as `{ok:false, error}`
 * envelopes (the same no-throw contract BetterWright.run keeps). `close()`
 * only disconnects — the session (tabs, state, logins) stays alive.
 */
export function createDaemonBrowser(channel, { session = "default" } = {}) {
  const pinned = sessionName(session);
  return {
    session: pinned,
    run: async (code, options) => {
      let reply;
      try {
        reply = await channel.request({
          op: "call",
          method: "run",
          args: [code, options],
          session: pinned,
        });
      } catch (error) {
        return { ok: false, error: `session daemon: ${error?.message || error}` };
      }
      if (!reply?.ok) return { ok: false, error: reply?.error || "session daemon call failed" };
      return reply.result;
    },
    closeSession: () => channel.request({ op: "close_session", session: pinned }, 60_000),
    close: async () => channel.end(),
  };
}

/**
 * Run one agent task inside the daemon (the Aside shape: the LLM loop lives
 * in the daemon, so its transcript and browser session persist across CLI
 * invocations). Step events stream to `onStep` as they happen; resolves with
 * the run summary (no transcript — that stays with the daemon).
 */
export async function execTask(channel, payload, { onStep } = {}) {
  const reply = await channel.request(
    { op: "exec", ...payload },
    0,
    typeof onStep === "function" ? onStep : undefined,
  );
  if (!reply?.ok) throw new Error(reply?.error || "the session daemon exec failed");
  return reply.result;
}
