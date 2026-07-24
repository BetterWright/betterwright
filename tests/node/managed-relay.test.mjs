import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  createManagedCipher,
  createManagedDecipher,
  createManagedRelayBridge,
  deriveManagedViewerProof,
} from "../../src/managed-relay.mjs";

const HOST_TO_VIEWER = 1;
const VIEWER_TO_HOST = 2;

test("managed relay proof is deterministic, session-bound, and does not reveal the root", () => {
  const root = Buffer.alloc(32, 7);
  const first = deriveManagedViewerProof(root, "session-a");
  assert.equal(first, deriveManagedViewerProof(root, "session-a"));
  assert.notEqual(first, deriveManagedViewerProof(root, "session-b"));
  assert.ok(!first.includes(root.toString("base64url")));
});

test("managed relay envelopes round-trip text and binary in each direction", () => {
  const root = crypto.randomBytes(32);
  for (const [direction, value] of [
    [HOST_TO_VIEWER, Buffer.from("hello")],
    [VIEWER_TO_HOST, crypto.randomBytes(48)],
  ]) {
    const sender = createManagedCipher({ root, sessionId: "abc", direction });
    const receiver = createManagedDecipher({ root, sessionId: "abc", direction });
    const envelope = sender.seal(direction === HOST_TO_VIEWER ? 0 : 1, value);
    const opened = receiver.open(envelope);
    assert.equal(opened.type, direction === HOST_TO_VIEWER ? "text" : "binary");
    assert.deepEqual(opened.data, value);
  }
});

test("managed relay rejects tampering, wrong roots, sessions, directions, and replay", () => {
  const root = crypto.randomBytes(32);
  const sender = createManagedCipher({ root, sessionId: "one", direction: HOST_TO_VIEWER });
  const envelope = sender.seal(0, Buffer.from("secret"));

  const good = createManagedDecipher({ root, sessionId: "one", direction: HOST_TO_VIEWER });
  assert.equal(good.open(envelope).data.toString(), "secret");
  assert.throws(() => good.open(envelope), /replay/i);

  const changed = Buffer.from(envelope);
  changed[changed.length - 17] ^= 1;
  assert.throws(
    () => createManagedDecipher({ root, sessionId: "one", direction: HOST_TO_VIEWER }).open(changed),
    /authenticate|auth|bad decrypt/i,
  );
  assert.throws(
    () => createManagedDecipher({ root: crypto.randomBytes(32), sessionId: "one", direction: HOST_TO_VIEWER }).open(envelope),
  );
  assert.throws(
    () => createManagedDecipher({ root, sessionId: "two", direction: HOST_TO_VIEWER }).open(envelope),
  );
  assert.throws(
    () => createManagedDecipher({ root, sessionId: "one", direction: VIEWER_TO_HOST }).open(envelope),
    /direction|version/i,
  );
});

test("managed relay rejects sender epoch changes without a reconnect reset", () => {
  const root = crypto.randomBytes(32);
  const receiver = createManagedDecipher({ root, sessionId: "one", direction: HOST_TO_VIEWER });
  const first = createManagedCipher({ root, sessionId: "one", direction: HOST_TO_VIEWER });
  const second = createManagedCipher({ root, sessionId: "one", direction: HOST_TO_VIEWER });
  receiver.open(first.seal(0, Buffer.from("first")));
  assert.throws(() => receiver.open(second.seal(0, Buffer.from("second"))), /epoch changed/i);
  receiver.reset();
  assert.equal(receiver.open(second.seal(0, Buffer.from("after reset"))).data.toString(), "after reset");
});


class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url, protocols = []) {
    this.url = String(url);
    this.protocols = protocols;
    this.readyState = MockWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    this.listeners = new Map();
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== MockWebSocket.CONNECTING) return;
      this.readyState = MockWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  send(value) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(value);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }
}

function relaySessionResponse(sessionId) {
  return {
    session: {
      id: sessionId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    host: {
      websocketUrl: `wss://live.betterwright.com/v1/sessions/${sessionId}/ws`,
      subprotocols: ["betterwright.relay.v1", `bw.host.${"h".repeat(43)}`],
    },
    viewer: {
      url: `https://live.betterwright.com/s/${sessionId}`,
      fragmentParameter: "k",
    },
  };
}

test("managed bridge validates the session response and relays only after root-key proof", async () => {
  MockWebSocket.instances = [];
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.match(body.sessionId, /^bws_[A-Za-z0-9_-]{24}$/);
      assert.match(body.viewerProof, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(JSON.stringify(body).includes("root"), false);
      return Response.json(relaySessionResponse(body.sessionId), { status: 201 });
    }
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected request ${options.method || "GET"} ${url}`);
  };

  const bridge = createManagedRelayBridge({
    localUrl: "http://127.0.0.1:4321/?t=local-capability",
    apiKey: `bw_live_${"a".repeat(16)}_${"b".repeat(43)}`,
    relayUrl: "https://live.betterwright.com",
    fetchImpl,
    WebSocketImpl: MockWebSocket,
  });
  const started = await bridge.start();
  assert.equal(started.ok, true);
  assert.equal(started.transport, "relay");
  assert.match(started.sessionId, /^bws_/);
  assert.equal(MockWebSocket.instances.length, 1);
  const remote = MockWebSocket.instances[0];
  assert.deepEqual(remote.protocols, ["betterwright.relay.v1", `bw.host.${"h".repeat(43)}`]);

  const viewerUrl = new URL(started.url);
  const root = Buffer.from(new URLSearchParams(viewerUrl.hash.slice(1)).get("k"), "base64url");
  assert.equal(root.length, 32);
  assert.equal(requests[0].options.body.includes(root.toString("base64url")), false);

  remote.emit("message", {
    data: JSON.stringify({ t: "relay", event: "viewer_connected", leaseExpiresAtMs: Date.now() + 60_000 }),
  });
  assert.equal(remote.sent.length, 1);
  const hostReader = createManagedDecipher({ root, sessionId: started.sessionId, direction: HOST_TO_VIEWER });
  const challenge = hostReader.open(remote.sent[0]);
  assert.equal(challenge.type, "challenge");
  const challengeBody = JSON.parse(challenge.data.toString("utf8"));
  assert.equal(challengeBody.t, "bw_e2e_challenge");

  // No local browser socket exists until the viewer proves possession of the
  // fragment root with a fresh connection epoch.
  assert.equal(MockWebSocket.instances.length, 1);
  const viewerWriter = createManagedCipher({ root, sessionId: started.sessionId, direction: VIEWER_TO_HOST });
  remote.emit("message", {
    data: viewerWriter.seal(
      2,
      Buffer.from(JSON.stringify({ t: "bw_e2e_ready", challenge: challengeBody.challenge })),
    ),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(MockWebSocket.instances.length, 2);
  const local = MockWebSocket.instances[1];
  assert.match(local.url, /^ws:\/\/127\.0\.0\.1:4321\/ws\?t=local-capability$/);

  local.emit("message", { data: JSON.stringify({ t: "hello", interactive: true }) });
  assert.equal(remote.sent.length, 2);
  const hello = hostReader.open(remote.sent[1]);
  assert.equal(hello.type, "text");
  assert.deepEqual(JSON.parse(hello.data.toString("utf8")), { t: "hello", interactive: true });

  const input = JSON.stringify({ t: "refresh" });
  remote.emit("message", { data: viewerWriter.seal(0, Buffer.from(input)) });
  assert.equal(local.sent.at(-1), input);

  await bridge.stop();
  assert.equal(requests.at(-1).options.method, "DELETE");
  assert.match(requests.at(-1).url, new RegExp(`/v1/sessions/${started.sessionId}$`));
});

test("managed bridge rejects relay-controlled URL redirects and can delete the provisional session", async () => {
  MockWebSocket.instances = [];
  const requests = [];
  const bridge = createManagedRelayBridge({
    localUrl: "http://127.0.0.1:4321/?t=local-capability",
    apiKey: `bw_live_${"a".repeat(16)}_${"b".repeat(43)}`,
    relayUrl: "https://live.betterwright.com",
    WebSocketImpl: MockWebSocket,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      const { sessionId } = JSON.parse(options.body);
      const body = relaySessionResponse(sessionId);
      body.host.websocketUrl = `wss://attacker.example/v1/sessions/${sessionId}/ws`;
      return Response.json(body, { status: 201 });
    },
  });
  await assert.rejects(() => bridge.start(), /untrusted WebSocket URL/i);
  await bridge.stop();
  assert.equal(MockWebSocket.instances.length, 0);
  assert.equal(requests.at(-1).options.method, "DELETE");
  assert.match(requests.at(-1).url, /\/v1\/sessions\/bws_[A-Za-z0-9_-]{24}$/);
});

test("managed bridge marks terminal relay events and cannot return a stale URL", async () => {
  MockWebSocket.instances = [];
  const terminalEvents = [];
  const fetchImpl = async (_url, options) => {
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    const { sessionId } = JSON.parse(options.body);
    return Response.json(relaySessionResponse(sessionId), { status: 201 });
  };
  const bridge = createManagedRelayBridge({
    localUrl: "http://127.0.0.1:4321/?t=local-capability",
    apiKey: `bw_live_${"a".repeat(16)}_${"b".repeat(43)}`,
    relayUrl: "https://live.betterwright.com",
    WebSocketImpl: MockWebSocket,
    fetchImpl,
    onTerminal: (event) => terminalEvents.push(event),
  });
  const started = await bridge.start();
  MockWebSocket.instances[0].emit("message", {
    data: JSON.stringify({ t: "relay", event: "session_expired" }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bridge.status().running, false);
  assert.equal(bridge.status().terminal, true);
  assert.match(bridge.status().error, /session_expired/);
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].status.sessionId, started.sessionId);
  await assert.rejects(() => bridge.start(), /session_expired|ended/i);
  await bridge.stop();
});

test("managed bridge surfaces a failed relay DELETE after a bounded retry", async () => {
  MockWebSocket.instances = [];
  let deleteAttempts = 0;
  const bridge = createManagedRelayBridge({
    localUrl: "http://127.0.0.1:4321/?t=local-capability",
    apiKey: `bw_live_${"a".repeat(16)}_${"b".repeat(43)}`,
    relayUrl: "https://live.betterwright.com",
    WebSocketImpl: MockWebSocket,
    fetchImpl: async (_url, options) => {
      if (options.method === "DELETE") {
        deleteAttempts += 1;
        return new Response("unavailable", { status: 503 });
      }
      const { sessionId } = JSON.parse(options.body);
      return Response.json(relaySessionResponse(sessionId), { status: 201 });
    },
  });
  await bridge.start();
  await assert.rejects(
    () => bridge.stop(),
    /cleanup returned HTTP 503/,
  );
  assert.equal(deleteAttempts, 2);
});

test("managed bridge does not retry deterministic cleanup authentication failures", async () => {
  MockWebSocket.instances = [];
  let deleteAttempts = 0;
  const bridge = createManagedRelayBridge({
    localUrl: "http://127.0.0.1:4321/?t=local-capability",
    apiKey: `bw_live_${"a".repeat(16)}_${"b".repeat(43)}`,
    relayUrl: "https://live.betterwright.com",
    WebSocketImpl: MockWebSocket,
    fetchImpl: async (_url, options) => {
      if (options.method === "DELETE") {
        deleteAttempts += 1;
        return new Response(null, { status: 401 });
      }
      const { sessionId } = JSON.parse(options.body);
      return Response.json(relaySessionResponse(sessionId), { status: 201 });
    },
  });
  await bridge.start();
  await assert.rejects(() => bridge.stop(), /cleanup returned HTTP 401/);
  assert.equal(deleteAttempts, 1);
});

test("managed bridge accepts an idempotent 404 cleanup and waits for DELETE", async () => {
  MockWebSocket.instances = [];
  let releaseDelete;
  let deleteStarted = false;
  const bridge = createManagedRelayBridge({
    localUrl: "http://127.0.0.1:4321/?t=local-capability",
    apiKey: `bw_live_${"a".repeat(16)}_${"b".repeat(43)}`,
    relayUrl: "https://live.betterwright.com",
    WebSocketImpl: MockWebSocket,
    fetchImpl: async (_url, options) => {
      if (options.method === "DELETE") {
        deleteStarted = true;
        await new Promise((resolve) => {
          releaseDelete = resolve;
        });
        return new Response(null, { status: 404 });
      }
      const { sessionId } = JSON.parse(options.body);
      return Response.json(relaySessionResponse(sessionId), { status: 201 });
    },
  });
  await bridge.start();
  let stopped = false;
  const stopping = bridge.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleteStarted, true);
  assert.equal(stopped, false);
  releaseDelete();
  await stopping;
  assert.equal(stopped, true);
});


test("core bridge crypto interoperates with the shipped Cloudflare viewer", async () => {
  const browserCrypto = await import("../../relay/public/viewer-crypto.js");
  const root = crypto.randomBytes(32);
  const rootKey = root.toString("base64url");
  const sessionId = `bws_${crypto.randomBytes(18).toString("base64url")}`;
  const hostEpoch = Buffer.alloc(16, 11);
  const viewerEpoch = new Uint8Array(16).fill(22);

  const hostWriter = createManagedCipher({
    root,
    sessionId,
    direction: HOST_TO_VIEWER,
    epoch: hostEpoch,
  });
  const browserReader = browserCrypto.createEnvelopeReceiver(rootKey, sessionId, "h2v");
  const fromHost = hostWriter.seal(0, Buffer.from("host text"));
  const openedByBrowser = await browserReader.open(fromHost);
  assert.equal(openedByBrowser.kind, browserCrypto.ENVELOPE_KIND.TEXT);
  assert.equal(new TextDecoder().decode(openedByBrowser.plaintext), "host text");

  const browserWriter = browserCrypto.createEnvelopeSender(
    rootKey,
    sessionId,
    "v2h",
    viewerEpoch,
  );
  const hostReader = createManagedDecipher({
    root,
    sessionId,
    direction: VIEWER_TO_HOST,
  });
  const fromViewer = await browserWriter.seal(
    browserCrypto.ENVELOPE_KIND.TEXT,
    new TextEncoder().encode("viewer text"),
  );
  assert.equal(hostReader.open(fromViewer).data.toString("utf8"), "viewer text");
});
