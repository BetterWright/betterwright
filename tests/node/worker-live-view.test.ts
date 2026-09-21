import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerLiveView } from "../../dist/src/worker-live-view.js";
import { createSession } from "../../dist/src/worker-session.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakePage(name: string, closed = false) {
  return Object.assign(Object.create(null), {
    name,
    isClosed: () => closed,
  });
}

function fakeServer(overrides = {}) {
  return {
    running: true,
    async start() {
      return { ok: true, running: true, url: "http://view.test" };
    },
    async stop() {},
    status() {
      return { ok: true, running: true };
    },
    async beginHandoff() {
      return { action: "continue", note: "" };
    },
    async beginAsk() {
      return { action: "answer", answer: "" };
    },
    postChat(message) {
      return message;
    },
    drainHumanMessages() {
      return [];
    },
    setAgentState() {},
    async refreshTabs() {},
    async followPreferred() {},
    url: "http://view.test",
    ...overrides,
  };
}

function fixture(server) {
  const sessions = new Map();
  const defaultSession = createSession("default");
  sessions.set(defaultSession.id, defaultSession);
  const results = [];
  let capturedServerOptions;
  const controller = createWorkerLiveView({
    getBrowserContext: () => Object.assign(Object.create(null), {
      async newCDPSession() {
        return {};
      },
      async newPage() {
        return fakePage("new");
      },
    }),
    sessions,
    sessionFor: (id) => {
      const sessionId = String(id || "default");
      let session = sessions.get(sessionId);
      if (!session) {
        session = createSession(sessionId);
        sessions.set(sessionId, session);
      }
      return session;
    },
    pageOwner: () => undefined,
    adoptPage: (page) => page,
    wakeSessionPages: async () => {},
    ensureBrowser: async () => {},
    sendResult: (message) => results.push(message),
    redactText: (value) => String(value ?? "").replaceAll("secret", "[redacted]"),
    serverFactory: (options) => {
      capturedServerOptions = options;
      return server;
    },
  });
  return {
    controller,
    sessions,
    defaultSession,
    results,
    serverOptions: () => capturedServerOptions,
  };
}

test("hasView reflects owned instance even before the server reports running", async () => {
  const server = fakeServer({ running: false });
  const { controller } = fixture(server);
  await controller.liveViewStart({ id: "start", options: {} });

  assert.equal(controller.hasView(), true);
});

test("stop clears ownership before awaiting server teardown", async () => {
  const teardown = deferred<void>();
  const stopCalls = [];
  const server = fakeServer({
    stop(options) {
      stopCalls.push(options);
      return teardown.promise;
    },
  });
  const { controller } = fixture(server);
  await controller.liveViewStart({ id: "start", options: {} });
  assert.equal(controller.hasView(), true);

  const stopping = controller.stop();
  assert.equal(controller.hasView(), false);
  assert.deepEqual(stopCalls, [undefined]);

  teardown.resolve();
  await stopping;
});

test("stop preserves notify:false for context close and shutdown", async () => {
  const stopCalls = [];
  const server = fakeServer({
    async stop(options) {
      stopCalls.push(options);
    },
  });
  const { controller } = fixture(server);
  await controller.liveViewStart({ id: "start", options: {} });

  await controller.stop({ notify: false });
  assert.deepEqual(stopCalls, [{ notify: false }]);
  assert.equal(controller.hasView(), false);
});

test("start tracks the preferred session and exposes its current open page", async () => {
  let followCalls = 0;
  const server = fakeServer({
    async followPreferred() {
      followCalls += 1;
    },
  });
  const { controller, sessions, serverOptions } = fixture(server);
  const alpha = createSession("alpha");
  const alphaPage = fakePage("alpha");
  alpha.pages.set("alpha-page", alphaPage);
  alpha.currentId = "alpha-page";
  sessions.set(alpha.id, alpha);
  const beta = createSession("beta");
  const betaPage = fakePage("beta");
  beta.pages.set("beta-page", betaPage);
  beta.currentId = "beta-page";
  sessions.set(beta.id, beta);

  await controller.liveViewStart({ id: "alpha-start", options: { session: "alpha" } });
  assert.equal(serverOptions().preferredPage(), alphaPage);

  await controller.liveViewStart({ id: "beta-start", options: { session: "beta" } });
  assert.equal(serverOptions().preferredPage(), betaPage);

  controller.notifyLiveViewPreferred();
  assert.equal(followCalls, 1);
});

test("handoff holds the session until completion and redacts its reply", async () => {
  const handoff = deferred<{ action: string; note: string }>();
  const server = fakeServer({
    beginHandoff() {
      return handoff.promise;
    },
  });
  const { controller, defaultSession, results } = fixture(server);
  await controller.liveViewStart({ id: "start", options: {} });

  const waiting = controller.handoffWait({
    id: "handoff",
    sessionId: "default",
    prompt: "help",
    timeoutMs: 10,
  });
  assert.notEqual(defaultSession.awaitingAnswerSince, null);

  handoff.resolve({ action: "continue", note: "secret note" });
  await waiting;
  assert.equal(defaultSession.awaitingAnswerSince, null);
  assert.deepEqual(results.at(-1), {
    type: "result",
    id: "handoff",
    ok: true,
    action: "continue",
    note: "[redacted] note",
  });
});

test("handoff clears its hold and redacts server failures", async () => {
  const server = fakeServer({
    async beginHandoff() {
      throw new Error("secret failure");
    },
  });
  const { controller, defaultSession, results } = fixture(server);
  await controller.liveViewStart({ id: "start", options: {} });

  await controller.handoffWait({ id: "handoff", sessionId: "default" });
  assert.equal(defaultSession.awaitingAnswerSince, null);
  assert.deepEqual(results.at(-1), {
    type: "result",
    id: "handoff",
    ok: false,
    error: "[redacted] failure",
  });
});
