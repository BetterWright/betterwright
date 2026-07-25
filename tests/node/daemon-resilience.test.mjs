// Resilience tests for the session daemon: what happens when the client goes
// away, when two things run at once, when a run has to be stopped, and when a
// client misbehaves. The happy paths live in daemon.test.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

import { sealTranscript } from "../../src/agent.mjs";
import { ReplayBuffer, startSessionDaemon } from "../../src/daemon.mjs";
import { execTask } from "../../src/daemon-client.mjs";
import { makeTempDir } from "./helpers/temp-dir.mjs";

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
      return { ok: true, closed: true, pagesClosed: 1 };
    },
    close: async function closeBrowser() {
      this.closed = true;
    },
  };
}

async function startTestDaemon(overrides = {}) {
  const home = makeTempDir("bw-dr-");
  const browser = overrides.browser || stubBrowser();
  const exits = [];
  const daemon = await startSessionDaemon({
    home,
    config: {},
    createBrowser: () => browser,
    onExit: (code) => exits.push(code),
    emptyGraceMs: 60_000,
    reapIntervalMs: overrides.reapIntervalMs || 50,
    ttlMs: overrides.ttlMs,
    orphanGraceMs: overrides.orphanGraceMs,
    finishedRunRetentionMs: overrides.finishedRunRetentionMs,
    runTask: overrides.runTask,
    log: () => {},
  });
  return {
    home,
    browser,
    daemon,
    exits,
    cleanup: async () => {
      await daemon.close().catch(() => {});
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A raw NDJSON channel that keeps every frame, including interim events. */
function rawChannel(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      let id = 0;
      const pending = new Map();
      const listeners = new Set();
      readline.createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
        const message = JSON.parse(line);
        for (const listener of listeners) listener(message);
        if (message.event) return;
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      });
      resolve({
        socket,
        onFrame: (listener) => listeners.add(listener),
        request: (payload) =>
          new Promise((res) => {
            id += 1;
            pending.set(id, res);
            socket.write(`${JSON.stringify({ id, ...payload })}\n`);
          }),
        send: (payload) => {
          id += 1;
          socket.write(`${JSON.stringify({ id, ...payload })}\n`);
          return id;
        },
        end: () => socket.destroy(),
      });
    });
  });
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A stand-in agent loop: emits `steps` progress notes, honours the abort
 * signal between them, and reports how it ended — the same contract
 * runAgentTask keeps.
 */
function scriptedTask({ steps = 3, stepDelayMs = 20, onStarted } = {}) {
  return async ({ signal, onStep, history = [] }) => {
    onStarted?.();
    const transcript = [...history, { role: "user", text: "task" }];
    for (let step = 1; step <= steps; step += 1) {
      if (signal?.aborted)
        return { ok: false, reason: "interrupted", steps: step - 1, answer: "", transcript };
      onStep({ step, tool: "browser", note: `step ${step}` });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, stepDelayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    if (signal?.aborted)
      return { ok: false, reason: "interrupted", steps, answer: "", transcript };
    return { ok: true, reason: "done", steps, answer: "finished", transcript };
  };
}

test("ReplayBuffer replays from a cursor and reports a gap when frames rolled out", () => {
  const buffer = new ReplayBuffer(3);
  for (let seq = 1; seq <= 5; seq += 1) buffer.append({ runId: "r1", seq, step: { seq } });

  // Holds the last 3 frames: 3, 4, 5.
  assert.deepEqual(
    buffer.since({ runId: "r1", seq: 4 }).frames.map((f) => f.seq),
    [5],
  );
  // Everything, when the client has seen nothing.
  assert.equal(buffer.since(null).frames.length, 3);
  // A cursor whose next frame (2) has already been evicted is a gap.
  const gap = buffer.since({ runId: "r1", seq: 1 });
  assert.equal(gap.kind, "gap");
  assert.equal(gap.firstSeq, 3);
  // A cursor from an older run says nothing about this one: replay it all.
  assert.equal(buffer.since({ runId: "other", seq: 99 }).frames.length, 3);
  // The boundary case: seq 2 is exactly the frame before the ring's first, so
  // frames 3..5 are contiguous with what the client already had.
  assert.equal(buffer.since({ runId: "r1", seq: 2 }).kind, "frames");
});

test("interrupt stops a run, keeps the transcript, and reports it", async () => {
  const fixture = await startTestDaemon({
    runTask: scriptedTask({ steps: 50, stepDelayMs: 20 }),
  });
  try {
    const client = await rawChannel(fixture.daemon.socketPath);
    const frames = [];
    client.onFrame((frame) => frames.push(frame));
    const execId = client.send({ op: "exec", task: "long", session: "s1" });
    await tick(60);

    const control = await rawChannel(fixture.daemon.socketPath);
    const stopped = await control.request({ op: "interrupt", session: "s1" });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.interrupted, true);

    const final = frames.find((frame) => frame.id === execId && !frame.event);
    assert.ok(final, "the interrupted run still answers its original request");
    assert.equal(final.ok, true);
    assert.equal(final.result.reason, "interrupted");
    assert.ok(final.result.steps < 50, "it stopped early");

    // The transcript survived, so the next exec can resume.
    const saved = path.join(fixture.home, "sessions", "s1", "transcript.json");
    assert.ok(fs.existsSync(saved), "an interrupted run still persists its transcript");

    // Interrupting again is a no-op, not an error.
    const again = await control.request({ op: "interrupt", session: "s1" });
    assert.equal(again.interrupted, false);
    client.end();
    control.end();
  } finally {
    await fixture.cleanup();
  }
});

test("a run whose watcher vanishes is interrupted after the orphan grace", async () => {
  let started = 0;
  const fixture = await startTestDaemon({
    orphanGraceMs: 50,
    runTask: scriptedTask({ steps: 200, stepDelayMs: 10, onStarted: () => (started += 1) }),
  });
  try {
    const client = await rawChannel(fixture.daemon.socketPath);
    client.send({ op: "exec", task: "long", session: "s1" });
    await tick(60);
    assert.equal(started, 1);

    // Hard kill of the client, the way a closed terminal looks.
    client.end();
    await tick(300);

    const probe = await rawChannel(fixture.daemon.socketPath);
    const status = await probe.request({ op: "status" });
    assert.equal(status.runs.active, 0, "the orphaned run was stopped, not left burning");
    probe.end();
  } finally {
    await fixture.cleanup();
  }
});

test("a detached run survives when the orphan grace is disabled", async () => {
  const fixture = await startTestDaemon({
    orphanGraceMs: 0,
    runTask: scriptedTask({ steps: 6, stepDelayMs: 30 }),
  });
  try {
    const client = await rawChannel(fixture.daemon.socketPath);
    client.send({ op: "exec", task: "long", session: "s1" });
    await tick(50);
    client.end();
    await tick(60);

    const probe = await rawChannel(fixture.daemon.socketPath);
    const mid = await probe.request({ op: "status" });
    assert.equal(mid.runs.active, 1, "nobody watching, but the run keeps going");
    await tick(300);
    const after = await probe.request({ op: "status" });
    assert.equal(after.runs.active, 0);
    probe.end();
  } finally {
    await fixture.cleanup();
  }
});

test("attach reattaches to a live run, replays missed steps, and gets the answer", async () => {
  const fixture = await startTestDaemon({
    orphanGraceMs: 5_000,
    runTask: scriptedTask({ steps: 8, stepDelayMs: 40 }),
  });
  try {
    const first = await rawChannel(fixture.daemon.socketPath);
    // Track exactly what the real client tracks: the last frame it saw.
    let cursor = null;
    const seen = [];
    first.onFrame((frame) => {
      if (frame.event !== "step") return;
      seen.push(frame.seq);
      cursor = { runId: frame.runId, seq: frame.seq };
    });
    first.send({ op: "exec", task: "long", session: "s1" });
    await tick(100);
    assert.ok(seen.length >= 1, "the first client saw some steps");
    first.end();

    const second = await rawChannel(fixture.daemon.socketPath);
    const replayed = [];
    second.onFrame((frame) => {
      if (frame.event === "step") replayed.push(frame.seq);
    });
    const final = await second.request({ op: "attach", session: "s1", cursor });
    assert.equal(final.ok, true);
    assert.equal(final.result.reason, "done");
    assert.equal(final.result.answer, "finished");
    // Every step the first client missed arrived on the second connection, in
    // order and without repeating what it had already seen.
    assert.ok(replayed.length > 0, "missed steps were replayed");
    assert.ok(
      replayed.every((seq) => seq > cursor.seq),
      `replay started after the cursor (got ${replayed.join(",")} for cursor ${cursor.seq})`,
    );
    assert.deepEqual(replayed, [...replayed].sort((a, b) => a - b), "frames stayed in order");
    second.end();
  } finally {
    await fixture.cleanup();
  }
});

test("attach to an already-finished run returns its stored answer", async () => {
  const fixture = await startTestDaemon({
    orphanGraceMs: 0,
    finishedRunRetentionMs: 60_000,
    runTask: scriptedTask({ steps: 2, stepDelayMs: 5 }),
  });
  try {
    const client = await rawChannel(fixture.daemon.socketPath);
    const done = await client.request({ op: "exec", task: "quick", session: "s1" });
    assert.equal(done.result.reason, "done");

    const late = await client.request({ op: "attach", session: "s1" });
    assert.equal(late.ok, true);
    assert.equal(late.result.answer, "finished", "a late arrival still collects the answer");
    client.end();
  } finally {
    await fixture.cleanup();
  }
});

test("attach reports honestly when there is no run to attach to", async () => {
  const fixture = await startTestDaemon({ runTask: scriptedTask({ steps: 1 }) });
  try {
    const client = await rawChannel(fixture.daemon.socketPath);
    const missing = await client.request({ op: "attach", session: "nope" });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /no run to attach to/);

    await client.request({ op: "exec", task: "quick", session: "s1" });
    const wrongRun = await client.request({ op: "attach", session: "s1", runId: "not-the-one" });
    assert.equal(wrongRun.ok, false);
    assert.match(wrongRun.error, /no longer available/);
    client.end();
  } finally {
    await fixture.cleanup();
  }
});

test("execTask reattaches through a dropped connection and returns the run's result", async () => {
  const fixture = await startTestDaemon({
    orphanGraceMs: 5_000,
    runTask: scriptedTask({ steps: 10, stepDelayMs: 40 }),
  });
  try {
    // A channel shaped like the real client's, so execTask drives it unchanged.
    const open = async () => {
      const raw = await rawChannel(fixture.daemon.socketPath);
      let nextId = 0;
      const pending = new Map();
      readline
        .createInterface({ input: raw.socket, crlfDelay: Infinity })
        .on("error", () => {});
      raw.onFrame((message) => {
        const entry = pending.get(message.id);
        if (!entry) return;
        if (message.event) {
          entry.onEvent?.(message);
          return;
        }
        pending.delete(message.id);
        entry.resolve(message);
      });
      const channel = {
        socket: raw.socket,
        request: (payload, _timeout, onEvent) =>
          new Promise((resolve, reject) => {
            nextId += 1;
            const id = nextId;
            pending.set(id, { resolve, reject, onEvent });
            raw.socket.on("close", () => {
              if (pending.delete(id)) reject(new Error("the session daemon connection closed"));
            });
            raw.socket.write(`${JSON.stringify({ id, ...payload })}\n`);
          }),
        end: () => raw.socket.destroy(),
      };
      return channel;
    };

    const notices = [];
    const steps = [];
    let channel = await open();
    setTimeout(() => channel.socket.destroy(), 120);

    const result = await execTask(
      channel,
      { task: "long", session: "s1" },
      {
        onStep: (step) => steps.push(step),
        onNotice: (note) => notices.push(note),
        reconnect: async () => {
          channel = await open();
          return channel;
        },
      },
    );
    assert.equal(result.reason, "done");
    assert.equal(result.answer, "finished");
    assert.ok(
      notices.some((note) => /reattaching/.test(note)),
      "the user was told the connection was recovered",
    );
    // Steps arrived from both connections with nothing duplicated.
    const numbers = steps.map((s) => s.step);
    assert.deepEqual(numbers, [...new Set(numbers)], `no duplicate steps: ${numbers.join(",")}`);
    channel.end();
  } finally {
    await fixture.cleanup();
  }
});

test("close_session stops a running agent before pulling its pages", async () => {
  const order = [];
  const browser = stubBrowser();
  browser.closeSession = async (session) => {
    order.push(`closeSession:${session}`);
    return { ok: true, closed: true, pagesClosed: 1 };
  };
  const fixture = await startTestDaemon({
    browser,
    orphanGraceMs: 5_000,
    runTask: async ({ signal, onStep }) => {
      for (let step = 1; step <= 100; step += 1) {
        if (signal?.aborted) {
          order.push("agent:interrupted");
          return { ok: false, reason: "interrupted", steps: step, answer: "", transcript: [] };
        }
        onStep({ step, tool: "browser", note: "working" });
        await tick(10);
      }
      return { ok: true, reason: "done", steps: 100, answer: "", transcript: [] };
    },
  });
  try {
    const client = await rawChannel(fixture.daemon.socketPath);
    client.send({ op: "exec", task: "long", session: "s1" });
    await tick(60);

    const control = await rawChannel(fixture.daemon.socketPath);
    const closed = await control.request({ op: "close_session", session: "s1" });
    assert.equal(closed.ok, true);
    assert.deepEqual(
      order,
      ["agent:interrupted", "closeSession:s1"],
      "the agent unwound before its pages were closed",
    );
    client.end();
    control.end();
  } finally {
    await fixture.cleanup();
  }
});

test("runs on different sessions proceed concurrently; one session stays serial", async () => {
  const active = { now: 0, peak: 0 };
  const perSession = new Map();
  const fixture = await startTestDaemon({
    runTask: async ({ session, onStep }) => {
      active.now += 1;
      active.peak = Math.max(active.peak, active.now);
      perSession.set(session, (perSession.get(session) || 0) + 1);
      const overlapWithinSession = perSession.get(session) > 1;
      onStep({ step: 1, tool: "browser", note: session });
      await tick(80);
      perSession.set(session, perSession.get(session) - 1);
      active.now -= 1;
      return {
        ok: true,
        reason: "done",
        steps: 1,
        answer: overlapWithinSession ? "OVERLAP" : "clean",
        transcript: [],
      };
    },
  });
  try {
    const client = await rawChannel(fixture.daemon.socketPath);
    const results = await Promise.all([
      client.request({ op: "exec", task: "a", session: "s1" }),
      client.request({ op: "exec", task: "b", session: "s2" }),
      client.request({ op: "exec", task: "c", session: "s3" }),
      client.request({ op: "exec", task: "d", session: "s1" }),
    ]);
    assert.equal(active.peak, 3, "three sessions ran at once");
    for (const reply of results)
      assert.equal(reply.result.answer, "clean", "two runs never shared one session");
    client.end();
  } finally {
    await fixture.cleanup();
  }
});

test("an oversized request line is refused instead of buffered", async () => {
  const fixture = await startTestDaemon({ runTask: scriptedTask({ steps: 1 }) });
  try {
    const socket = net.connect(fixture.daemon.socketPath);
    await new Promise((resolve) => socket.once("connect", resolve));
    const replies = [];
    readline.createInterface({ input: socket }).on("line", (line) => replies.push(JSON.parse(line)));
    socket.write(`${JSON.stringify({ id: 1, op: "exec", task: "x".repeat(9 * 1024 * 1024) })}\n`);
    await tick(400);
    assert.equal(replies.at(-1)?.ok, false);
    assert.match(replies.at(-1)?.error, /too large/);

    // The daemon is still healthy for everyone else.
    const probe = await rawChannel(fixture.daemon.socketPath);
    assert.equal((await probe.request({ op: "status" })).ok, true);
    probe.end();
  } finally {
    await fixture.cleanup();
  }
});

test("status reports uptime, run counts, and per-session activity", async () => {
  const fixture = await startTestDaemon({
    orphanGraceMs: 5_000,
    runTask: scriptedTask({ steps: 30, stepDelayMs: 20 }),
  });
  try {
    const client = await rawChannel(fixture.daemon.socketPath);
    client.send({ op: "exec", task: "long", session: "s1" });
    await tick(60);

    const probe = await rawChannel(fixture.daemon.socketPath);
    const status = await probe.request({ op: "status" });
    assert.ok(status.uptimeMs >= 0);
    assert.ok(status.startedAt);
    assert.equal(status.runs.started, 1);
    assert.equal(status.runs.active, 1);
    const entry = status.sessions.find((s) => s.name === "s1");
    assert.equal(entry.running, true);
    assert.equal(entry.watchers, 1, "the exec client counts as a watcher");
    client.end();
    probe.end();
  } finally {
    await fixture.cleanup();
  }
});

test("sealTranscript closes a turn cut short mid tool call", () => {
  const messages = [
    { role: "user", text: "go" },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "browser" }] },
  ];
  sealTranscript(messages, "interrupted");
  assert.equal(messages.length, 3);
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[2].results[0].id, "c1");
  assert.match(messages[2].results[0].content, /interrupted/);

  // Already balanced: nothing is appended.
  const balanced = [
    { role: "user", text: "go" },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "browser" }] },
    { role: "tool", results: [{ id: "c1", name: "browser", content: "ok" }] },
  ];
  sealTranscript(balanced, "done");
  assert.equal(balanced.length, 3);

  // A plain assistant turn needs no sealing.
  const plain = [{ role: "user", text: "go" }, { role: "assistant", text: "done" }];
  sealTranscript(plain, "timeout");
  assert.equal(plain.length, 2);
});
