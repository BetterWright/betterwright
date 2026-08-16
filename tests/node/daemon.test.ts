import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
import test from "node:test";
import {
  daemonConfigSignature,
  daemonPackageVersion,
  daemonSocketPath,
  ensureSocketDirectory,
  fallbackSocketDir,
  normalizeDaemonConfig,
  startSessionDaemon,
} from "../../dist/src/daemon.js";
import {
  connectSessionDaemon,
  createDaemonBrowser,
  execTask,
} from "../../dist/src/daemon-client.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function stubBrowser() {
  const calls = [];
  return {
    calls,
    vault: {},
    closed: false,
    run: async (code, options) => {
      calls.push(["run", code, options]);
      return { ok: true, result: `ran:${code}`, session: options.session };
    },
    closeSession: async (session) => {
      calls.push(["closeSession", session]);
      return { ok: true, closed: true, pagesClosed: 2 };
    },
    close: async function closeBrowser() {
      this.closed = true;
    },
  };
}

interface DaemonTaskResult {
  ok: boolean;
  answer: string;
  steps: number;
  reason: string;
  toolCalls: number;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    context?: number;
  };
  durationMs: number;
  transcript: Array<{ role: string; text: string }>;
  proof: string | null;
}

interface DaemonOverrides {
  browser?: ReturnType<typeof stubBrowser>;
  config?: { policy?: { blockHosts?: string[] } };
  ttlMs?: number;
  emptyGraceMs?: number;
  reapIntervalMs?: number;
  runTask?: (options: {
    task: string;
    session: string;
    history: Array<{ role: string; text: string }>;
    onStep: (step: { step: number; tool: string; note: string }) => void;
  }) => Promise<DaemonTaskResult>;
}

async function startTestDaemon(overrides: DaemonOverrides = {}) {
  const home = makeTempDir("bw-d-");
  const browser = overrides.browser || stubBrowser();
  const exits = [];
  const daemon = await startSessionDaemon({
    home,
    config: overrides.config || {},
    createBrowser: () => browser,
    onExit: (code) => exits.push(code),
    ttlMs: overrides.ttlMs,
    emptyGraceMs: overrides.emptyGraceMs || 60_000,
    reapIntervalMs: overrides.reapIntervalMs,
    runTask: overrides.runTask,
    log: () => {},
  });
  const cleanup = async () => {
    await daemon.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { home, browser, daemon, exits, cleanup };
}

interface RawChannel {
  socket: net.Socket;
  request: (payload: any) => Promise<any>;
  end: () => void;
}

function rawChannel(socketPath): Promise<RawChannel> {
  return new Promise<RawChannel>((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      let id = 0;
      const pending = new Map<number, (message: any) => void>();
      readline.createInterface({ input: socket }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.event === "step") return;
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      });
      resolve({
        socket,
        request: (payload) =>
          new Promise<any>((res) => {
            id += 1;
            pending.set(id, res);
            socket.write(`${JSON.stringify({ id, ...payload })}\n`);
          }),
        end: () => socket.destroy(),
      });
    });
  });
}

test("hello reports identity; call run pins the session; sessions are tracked", async () => {
  const { home, browser, cleanup } = await startTestDaemon();
  try {
    const channel = await rawChannel(daemonSocketPath(home));
    const hello = await channel.request({ op: "hello", version: "x", configSig: "y" });
    assert.equal(hello.ok, true);
    assert.equal(hello.version, daemonPackageVersion());
    assert.equal(hello.configSig, daemonConfigSignature({}));
    assert.equal(hello.withVault, true);
    assert.deepEqual(hello.sessions, []);

    const reply = await channel.request({
      op: "call",
      method: "run",
      args: ["1+1", { session: "spoofed" }],
      session: "mine",
    });
    assert.equal(reply.ok, true);
    assert.equal(reply.result.result, "ran:1+1");
    // The daemon pins the request's session over anything inside args.
    assert.equal(browser.calls.at(-1)[2].session, "mine");

    const status = await channel.request({ op: "status" });
    assert.deepEqual(
      status.sessions.map((s) => s.name),
      ["mine"],
    );
    channel.end();
  } finally {
    await cleanup();
  }
});

test("disallowed methods are rejected", async () => {
  const { home, cleanup } = await startTestDaemon();
  try {
    const channel = await rawChannel(daemonSocketPath(home));
    const reply = await channel.request({ op: "call", method: "constructor", args: [] });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /disallowed/i);
    const unknown = await channel.request({ op: "wat" });
    assert.equal(unknown.ok, false);
    channel.end();
  } finally {
    await cleanup();
  }
});

test("close_session closes worker pages and the last close shuts the daemon down", async () => {
  const { home, browser, exits, cleanup } = await startTestDaemon({ emptyGraceMs: 300 });
  try {
    const channel = await rawChannel(daemonSocketPath(home));
    await channel.request({ op: "call", method: "run", args: ["a"], session: "one" });
    const closed = await channel.request({ op: "close_session", session: "one" });
    assert.equal(closed.closed, true);
    assert.equal(closed.pagesClosed, 2);
    assert.deepEqual(browser.calls.at(-1), ["closeSession", "one"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(exits, [0]);
    assert.equal(browser.closed, true);
    channel.end();
  } finally {
    await cleanup();
  }
});

test("idle sessions are reaped after the TTL and the empty daemon exits", async () => {
  const { home, browser, exits, cleanup } = await startTestDaemon({
    ttlMs: 1_000,
    reapIntervalMs: 60,
    emptyGraceMs: 300,
  });
  try {
    const channel = await rawChannel(daemonSocketPath(home));
    await channel.request({ op: "call", method: "run", args: ["a"], session: "idle-me" });
    channel.end();
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    assert.ok(
      browser.calls.some(([kind, name]) => kind === "closeSession" && name === "idle-me"),
      "TTL reaper closes the idle session",
    );
    assert.deepEqual(exits, [0]);
  } finally {
    await cleanup();
  }
});

test("exec runs in the daemon, streams steps, and resumes the transcript next time", async () => {
  const seen = [];
  const runTask = async (options) => {
    seen.push({ history: options.history, task: options.task, session: options.session });
    options.onStep({ step: 1, tool: "browser", note: `working on ${options.task}` });
    return {
      ok: true,
      answer: `answer:${options.task}`,
      steps: 1,
      reason: "done",
      toolCalls: 1,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, context: 2 },
      durationMs: 5,
      transcript: [
        ...options.history,
        { role: "user", text: options.task },
        { role: "assistant", text: `answer:${options.task}`, toolCalls: [] },
      ],
      proof: null,
    };
  };
  const { home, cleanup } = await startTestDaemon({ runTask });
  try {
    const outcome = await connectSessionDaemon({ home, spawnIfNeeded: false });
    assert.equal(outcome.ok, true);
    const steps = [];
    const first = await execTask(
      outcome.channel,
      { task: "task-1", session: "default", model: "stub" },
      { onStep: (step) => steps.push(step) },
    );
    assert.equal(first.ok, true);
    assert.equal(first.answer, "answer:task-1");
    assert.equal(first.resumedMessages, 0);
    assert.equal(first.transcript, undefined, "transcript stays in the daemon");
    assert.deepEqual(steps, [{ step: 1, tool: "browser", note: "working on task-1" }]);

    const second = await execTask(outcome.channel, {
      task: "task-2",
      session: "default",
      model: "stub",
    });
    assert.equal(second.resumedMessages, 2, "second exec resumes the first conversation");
    assert.equal(seen[1].history.at(-1).text, "answer:task-1");

    // --fresh forgets the conversation.
    const third = await execTask(outcome.channel, {
      task: "task-3",
      session: "default",
      model: "stub",
      fresh: true,
    });
    assert.equal(third.resumedMessages, 0);
    outcome.channel.end();
  } finally {
    await cleanup();
  }
});

test("exec transcript survives a daemon restart via the on-disk store", async () => {
  const runTask = async (options) => ({
    ok: true,
    answer: "done",
    steps: 1,
    reason: "done",
    toolCalls: 0,
    usage: {},
    durationMs: 1,
    transcript: [
      ...options.history,
      { role: "user", text: options.task },
      { role: "assistant", text: "done", toolCalls: [] },
    ],
    proof: null,
  });
  const first = await startTestDaemon({ runTask });
  let home;
  try {
    home = first.home;
    const outcome = await connectSessionDaemon({ home, spawnIfNeeded: false });
    await execTask(outcome.channel, { task: "remember me", session: "default" });
    outcome.channel.end();
  } finally {
    await first.daemon.close().catch(() => {});
  }
  // New daemon, same home: history reloads from disk.
  const browser = stubBrowser();
  const daemon = await startSessionDaemon({
    home,
    config: {},
    createBrowser: () => browser,
    onExit: () => {},
    runTask,
    log: () => {},
  });
  try {
    const outcome = await connectSessionDaemon({ home, spawnIfNeeded: false });
    const result = await execTask(outcome.channel, { task: "next", session: "default" });
    assert.equal(result.resumedMessages, 2);
    outcome.channel.end();
  } finally {
    await daemon.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("createDaemonBrowser proxies run and survives daemon death with an envelope", async () => {
  const { home, daemon, cleanup } = await startTestDaemon();
  try {
    const outcome = await connectSessionDaemon({ home, spawnIfNeeded: false });
    const proxy = createDaemonBrowser(outcome.channel, { session: "p" });
    const result = await proxy.run("2+2", {});
    assert.equal(result.result, "ran:2+2");
    await daemon.close();
    const dead = await proxy.run("3+3", {});
    assert.equal(dead.ok, false);
    assert.match(dead.error, /session daemon/);
    await proxy.close();
  } finally {
    await cleanup();
  }
});

test("createDaemonBrowser proxies startLiveView mid-session on the daemon browser", async () => {
  const stub = stubBrowser();
  const browser = {
    ...stub,
    startLiveView: async (options) => {
      stub.calls.push(["startLiveView", options]);
      return {
        ok: true,
        url: "http://127.0.0.1:4242/?t=tok",
        host: "127.0.0.1",
        port: 4242,
        session: options.session,
      };
    },
  };
  const { home, cleanup } = await startTestDaemon({ browser });
  try {
    // Simulate work already happening in the session.
    const seed = await connectSessionDaemon({ home, spawnIfNeeded: false });
    assert.equal(seed.ok, true);
    await createDaemonBrowser(seed.channel, { session: "default" }).run("warmup", {});
    seed.channel.end();

    const outcome = await connectSessionDaemon({ home, spawnIfNeeded: false });
    const proxy = createDaemonBrowser(outcome.channel, { session: "default" });
    const view = await proxy.startLiveView({ expose: "local" });
    assert.equal(view.ok, true);
    assert.equal(view.url, "http://127.0.0.1:4242/?t=tok");
    assert.equal(browser.calls.some((c) => c[0] === "startLiveView"), true);
    const liveCall = browser.calls.find((c) => c[0] === "startLiveView");
    assert.equal(liveCall[1].session, "default");
    await proxy.close();
  } finally {
    await cleanup();
  }
});

test("config mismatch on a busy daemon falls back; ignoreMismatch connects anyway", async () => {
  const { home, cleanup } = await startTestDaemon({
    config: { policy: { blockHosts: ["x.example"] } },
  });
  try {
    // Open a session so the daemon counts as busy.
    const seed = await connectSessionDaemon({
      home,
      spawnIfNeeded: false,
      config: { policy: { blockHosts: ["x.example"] } },
    });
    assert.equal(seed.ok, true);
    await seed.channel.request({ op: "call", method: "run", args: ["a"], session: "default" });

    const mismatched = await connectSessionDaemon({ home, spawnIfNeeded: false, config: {} });
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.reason, /different browser flags/);

    const forced = await connectSessionDaemon({
      home,
      spawnIfNeeded: false,
      config: {},
      ignoreMismatch: true,
    });
    assert.equal(forced.ok, true);
    forced.channel.end();
    seed.channel.end();
  } finally {
    await cleanup();
  }
});

test("normalizeDaemonConfig is order-insensitive and default-stable", () => {
  const a = daemonConfigSignature({
    policy: { allowHosts: ["B.com", "a.com"], blockHosts: [] },
    browser: { launchIdentity: true },
    headless: true,
  });
  const b = daemonConfigSignature({
    headless: true,
    browser: {},
    policy: { allowHosts: ["a.com", "b.com", "a.com"] },
  });
  assert.equal(a, b);
  assert.notEqual(a, daemonConfigSignature({ headless: false }));
  assert.equal(
    normalizeDaemonConfig({}).browser.stealthRuntimeFix,
    false,
  );
  assert.equal(normalizeDaemonConfig({}).browser.provider, null);
  // Two different provider browsers must not share a daemon.
  assert.notEqual(
    daemonConfigSignature({ browser: { provider: { provider: "kernel", apiKey: "a" } } }),
    daemonConfigSignature({ browser: { provider: { provider: "kernel", apiKey: "b" } } }),
  );
});

// A unix socket path longer than sockaddr_un.sun_path (104 bytes on macOS,
// 108 on Linux) fails `listen` with EINVAL. Before the fallback, a deep
// BETTERWRIGHT_HOME therefore lost session persistence silently: the daemon
// died, and every run fell back to a private browser.
test("an over-long home falls back to a bindable socket path", { skip: process.platform === "win32" }, () => {
  const shallow = "/tmp/bw";
  assert.equal(daemonSocketPath(shallow), "/tmp/bw/daemon.sock");

  const deep = `/tmp/${"nested/".repeat(20)}home`;
  const fallback = daemonSocketPath(deep);
  assert.notEqual(fallback, `${deep}/daemon.sock`);
  assert.ok(
    Buffer.byteLength(fallback) <= 104,
    `fallback socket path is still ${Buffer.byteLength(fallback)} bytes`,
  );
  assert.ok(fallback.startsWith(fallbackSocketDir()));

  // Different homes must not collide onto one socket.
  assert.notEqual(fallback, daemonSocketPath(`${deep}-other`));
  // And resolution is stable, so a client and the daemon agree.
  assert.equal(fallback, daemonSocketPath(deep));
});

test("an over-long symlinked home hashes the same before and after it exists", { skip: process.platform === "win32" }, () => {
  // The client computes the socket path before spawnDaemon creates the home;
  // the daemon computes it after. For an over-long home under a symlinked
  // ancestor those two moments must agree, or the client polls a socket the
  // daemon never binds and silently loses session persistence — which is
  // exactly what a naive realpath (resolvable only once the path exists) did.
  const root = makeTempDir("betterwright-symhome-");
  const real = `${root}/real`;
  fs.mkdirSync(real);
  const link = `${root}/link`;
  fs.symlinkSync(real, link);
  const tail = `${"d".repeat(40)}/${"e".repeat(40)}/${"f".repeat(40)}`;
  const deep = `${link}/${tail}`;
  assert.ok(Buffer.byteLength(`${deep}/daemon.sock`) > 100, "fixture must be over-long");

  const beforeExists = daemonSocketPath(deep); // client, home not yet created
  fs.mkdirSync(deep, { recursive: true });
  const afterExists = daemonSocketPath(deep); // daemon, home now created
  assert.equal(beforeExists, afterExists);

  // The symlinked spelling and its real target still converge onto one socket.
  assert.equal(daemonSocketPath(`${real}/${tail}`), afterExists);
});

test("the shared-tmpdir fallback directory is created owner-only", { skip: process.platform === "win32" }, () => {
  // Only the fallback lives under a shared os.tmpdir(), so only it is
  // hardened to 0700.
  const socketPath = `${fallbackSocketDir()}/test-${process.pid}.sock`;

  ensureSocketDirectory(socketPath);

  const stats = fs.statSync(fallbackSocketDir());
  assert.equal(stats.mode & 0o777, 0o700);
  // Idempotent: a second call on an existing directory must not throw.
  ensureSocketDirectory(socketPath);
});

test("a socket in the user's own home is not hardened or rejected", { skip: process.platform === "win32" }, () => {
  // The natural path puts the socket directly in BETTERWRIGHT_HOME. That is
  // the user's directory: a previous version rejected a symlinked home and
  // silently chmod-ed it to 0700, breaking setups that worked. It must now be
  // left as the user set it.
  const realHome = makeTempDir("betterwright-real-home-");
  fs.chmodSync(realHome, 0o755); // a home the user deliberately left group-readable
  ensureSocketDirectory(`${realHome}/daemon.sock`);
  assert.equal(fs.statSync(realHome).mode & 0o777, 0o755, "permissions left untouched");

  // A symlinked home is tolerated rather than throwing.
  const linkParent = makeTempDir("betterwright-link-parent-");
  const link = `${linkParent}/home`;
  fs.symlinkSync(realHome, link);
  assert.doesNotThrow(() => ensureSocketDirectory(`${link}/daemon.sock`));
});

test("a daemon on an over-long home actually accepts connections", { skip: process.platform === "win32" }, async () => {
  const root = makeTempDir("betterwright-deep-");
  const home = `${root}/${"d".repeat(40)}/${"e".repeat(40)}/${"f".repeat(40)}`;
  fs.mkdirSync(home, { recursive: true });
  assert.ok(
    Buffer.byteLength(`${home}/daemon.sock`) > 104,
    "the fixture home must actually exceed the socket limit",
  );

  // onExit matters: without it the daemon's shutdown path calls process.exit,
  // which would take the test runner down with it.
  const exits = [];
  const daemon = await startSessionDaemon({
    home,
    createBrowser: () => stubBrowser(),
    onExit: (code) => exits.push(code),
    emptyGraceMs: 60_000,
    log: () => {},
  });
  try {
    const channel = await rawChannel(daemonSocketPath(home));
    const hello = await channel.request({
      op: "hello",
      version: daemonPackageVersion(),
      configSig: daemonConfigSignature(normalizeDaemonConfig({})),
    });
    assert.equal(hello.ok, true, `handshake failed: ${JSON.stringify(hello)}`);
    // A run over the fallback socket proves the daemon is genuinely usable,
    // not merely bound.
    const ran = await channel.request({
      op: "call",
      method: "run",
      args: ["1 + 1"],
      session: "deep",
    });
    assert.equal(ran.ok, true);
    channel.end();
  } finally {
    await daemon.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
