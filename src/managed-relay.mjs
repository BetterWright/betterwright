// Outbound BetterWright managed-relay bridge.
//
// The existing live-view server remains loopback-only and owns all browser/CDP
// behavior. This bridge connects to that local WebSocket only while a remote
// viewer is present, wraps its text/binary protocol in endpoint-to-endpoint
// AES-256-GCM, and forwards opaque envelopes over an outbound WSS connection.
// The relay never receives the root key and therefore cannot decrypt browser
// pixels, chat, or input.

import crypto from "node:crypto";

import { normalizeRelayUrl } from "./account-config.mjs";

const PROTOCOL_VERSION = 1;
const HEADER_BYTES = 26;
const EPOCH_BYTES = 16;
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const REMOTE_BACKPRESSURE_BYTES = 1_500_000;
const MAX_RECONNECT_DELAY_MS = 10_000;
const CREATE_TIMEOUT_MS = 15_000;
const DELETE_TIMEOUT_MS = 3_500;
const DELETE_ATTEMPTS = 2;
const TEXT_PAYLOAD = 0;
const BINARY_PAYLOAD = 1;
const CHALLENGE_PAYLOAD = 2;
const HOST_TO_VIEWER = 1;
const VIEWER_TO_HOST = 2;
const RELAY_PROTOCOL = "betterwright.relay.v1";
const HOST_PROTOCOL_PREFIX = "bw.host.";
const TERMINAL_CLOSE_CODES = new Set([4401, 4403, 4408, 4411, 4412, 4414, 4415, 4416]);

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}

function randomBase64Url(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function constantEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function deriveManagedViewerProof(root, sessionId) {
  const key = Buffer.isBuffer(root) ? root : Buffer.from(String(root), "base64url");
  if (key.length !== 32) throw new Error("Managed relay root key must be 32 bytes.");
  return crypto
    .createHmac("sha256", key)
    .update(`BetterWright relay viewer proof v1\0${String(sessionId)}`)
    .digest("base64url");
}

function deriveDirectionKey(root, epoch, sessionId, direction) {
  const label = direction === HOST_TO_VIEWER ? "host-to-viewer" : "viewer-to-host";
  const salt = crypto
    .createHash("sha256")
    .update(Buffer.from(`BetterWright relay HKDF salt v1\0${sessionId}\0`, "utf8"))
    .update(epoch)
    .digest();
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      root,
      salt,
      Buffer.from(`BetterWright relay ${label} AES-GCM v1`, "utf8"),
      32,
    ),
  );
}

function nonceFor(direction, sequence) {
  const nonce = Buffer.alloc(12);
  nonce[0] = PROTOCOL_VERSION;
  nonce[1] = direction;
  nonce.writeBigUInt64BE(sequence, 4);
  return nonce;
}

function aadFor(header, sessionId, direction) {
  const label = direction === HOST_TO_VIEWER ? "h2v" : "v2h";
  return Buffer.concat([
    header,
    Buffer.from(`BetterWright relay envelope v1\0${String(sessionId)}\0${label}`, "utf8"),
  ]);
}

export function createManagedCipher({ root, sessionId, direction, epoch = crypto.randomBytes(EPOCH_BYTES) }) {
  const keyRoot = Buffer.isBuffer(root) ? root : Buffer.from(String(root), "base64url");
  if (keyRoot.length !== 32) throw new Error("Managed relay root key must be 32 bytes.");
  if (![HOST_TO_VIEWER, VIEWER_TO_HOST].includes(direction)) {
    throw new Error("Invalid managed relay direction.");
  }
  const senderEpoch = asBuffer(epoch);
  if (senderEpoch.length !== EPOCH_BYTES) throw new Error("Managed relay epoch must be 16 bytes.");
  const key = deriveDirectionKey(keyRoot, senderEpoch, sessionId, direction);
  let sequence = 0n;
  return {
    get epoch() {
      return Buffer.from(senderEpoch);
    },
    seal(type, value) {
      const body = asBuffer(value);
      if (body.length + HEADER_BYTES + 17 > MAX_ENVELOPE_BYTES) {
        throw new Error("Managed relay message exceeds the 2 MiB limit.");
      }
      const header = Buffer.alloc(HEADER_BYTES);
      header[0] = PROTOCOL_VERSION;
      header[1] = direction;
      senderEpoch.copy(header, 2);
      header.writeBigUInt64BE(sequence, 18);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonceFor(direction, sequence));
      cipher.setAAD(aadFor(header, sessionId, direction));
      const plaintext = Buffer.concat([Buffer.from([type]), body]);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      sequence += 1n;
      return Buffer.concat([header, ciphertext, tag]);
    },
  };
}

export function createManagedDecipher({ root, sessionId, direction }) {
  const keyRoot = Buffer.isBuffer(root) ? root : Buffer.from(String(root), "base64url");
  if (keyRoot.length !== 32) throw new Error("Managed relay root key must be 32 bytes.");
  let epochHex = "";
  let key = null;
  let lastSequence = -1n;
  return {
    reset() {
      epochHex = "";
      key = null;
      lastSequence = -1n;
    },
    open(value) {
      const envelope = asBuffer(value);
      if (envelope.length < HEADER_BYTES + 17 || envelope.length > MAX_ENVELOPE_BYTES) {
        throw new Error("Invalid managed relay envelope size.");
      }
      const header = envelope.subarray(0, HEADER_BYTES);
      if (header[0] !== PROTOCOL_VERSION || header[1] !== direction) {
        throw new Error("Managed relay protocol direction/version mismatch.");
      }
      const epoch = header.subarray(2, 18);
      const nextEpochHex = epoch.toString("hex");
      const sequence = header.readBigUInt64BE(18);
      if (!epochHex) {
        epochHex = nextEpochHex;
        key = deriveDirectionKey(keyRoot, epoch, sessionId, direction);
      } else if (nextEpochHex !== epochHex) {
        throw new Error("Managed relay sender epoch changed without reconnect.");
      }
      if (sequence <= lastSequence) throw new Error("Managed relay replay rejected.");
      const ciphertext = envelope.subarray(HEADER_BYTES, -16);
      const tag = envelope.subarray(-16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonceFor(direction, sequence));
      decipher.setAAD(aadFor(header, sessionId, direction));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (!plaintext.length || ![TEXT_PAYLOAD, BINARY_PAYLOAD, CHALLENGE_PAYLOAD].includes(plaintext[0])) {
        throw new Error("Managed relay payload type is invalid.");
      }
      lastSequence = sequence;
      return {
        type:
          plaintext[0] === TEXT_PAYLOAD
            ? "text"
            : plaintext[0] === BINARY_PAYLOAD
              ? "binary"
              : "challenge",
        data: plaintext.subarray(1),
      };
    },
  };
}

function localWebSocketUrl(localUrl) {
  const parsed = new URL(localUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws";
  return parsed.toString();
}

function responseError(status, body) {
  const code = typeof body?.error?.code === "string" ? body.error.code : body?.code;
  const message =
    typeof body?.error?.message === "string"
      ? body.error.message
      : typeof body?.error === "string"
        ? body.error
        : "";
  if (status === 401) return "BetterWright API key was rejected. Create a new key at https://betterwright.com/account.";
  if (status === 402 || code === "budget_exhausted") {
    return "BetterWright managed relay is temporarily unavailable because its monthly safety budget was reached.";
  }
  if (status === 429 || code === "weekly_quota_exhausted" || code === "quota_exhausted") {
    return message || "Your two-hour weekly managed-relay allowance has been used.";
  }
  if (code === "relay_disabled") {
    return "BetterWright managed Live View is temporarily paused by its safety switch.";
  }
  return message || `BetterWright relay returned HTTP ${status}.`;
}

function expectedSessionUrls(relayUrl, sessionId) {
  const base = new URL(relayUrl);
  const viewer = new URL(`/s/${encodeURIComponent(sessionId)}`, base);
  const websocket = new URL(`/v1/sessions/${encodeURIComponent(sessionId)}/ws`, base);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  return { viewer, websocket };
}

function validHostProtocols(protocols) {
  return (
    Array.isArray(protocols) &&
    protocols.length === 2 &&
    protocols[0] === RELAY_PROTOCOL &&
    typeof protocols[1] === "string" &&
    new RegExp(`^${HOST_PROTOCOL_PREFIX.replaceAll(".", "\\.")}[A-Za-z0-9_-]{43}$`).test(protocols[1])
  );
}

function validateSessionResponse(body, relayUrl, sessionId, root) {
  if (body?.session?.id !== sessionId) throw new Error("BetterWright relay returned the wrong session ID.");
  const expected = expectedSessionUrls(relayUrl, sessionId);
  let returnedWebSocket;
  let returnedViewer;
  try {
    returnedWebSocket = new URL(String(body?.host?.websocketUrl || ""));
    returnedViewer = new URL(String(body?.viewer?.url || ""));
  } catch {
    throw new Error("BetterWright relay returned invalid session URLs.");
  }
  const expectedWsProtocol = expected.websocket.protocol;
  if (
    returnedWebSocket.protocol !== expectedWsProtocol ||
    returnedWebSocket.host !== expected.websocket.host ||
    returnedWebSocket.pathname !== expected.websocket.pathname ||
    returnedWebSocket.username ||
    returnedWebSocket.password ||
    returnedWebSocket.search ||
    returnedWebSocket.hash
  ) {
    throw new Error("BetterWright relay returned an untrusted WebSocket URL.");
  }
  if (
    returnedViewer.protocol !== expected.viewer.protocol ||
    returnedViewer.host !== expected.viewer.host ||
    returnedViewer.pathname !== expected.viewer.pathname ||
    returnedViewer.username ||
    returnedViewer.password ||
    returnedViewer.search ||
    returnedViewer.hash
  ) {
    throw new Error("BetterWright relay returned an untrusted viewer URL.");
  }
  const protocols = body?.host?.subprotocols;
  if (!validHostProtocols(protocols)) {
    throw new Error("BetterWright relay returned invalid host credentials.");
  }
  expected.viewer.hash = `k=${root.toString("base64url")}`;
  return {
    websocketUrl: expected.websocket.toString(),
    subprotocols: [...protocols],
    viewerUrl: expected.viewer.toString(),
  };
}

function validateRestoreState(session, relayUrl, root) {
  if (!session || !/^bws_[A-Za-z0-9_-]{24}$/.test(String(session.sessionId || ""))) {
    throw new Error("Managed relay restore state has an invalid session ID.");
  }
  const expected = expectedSessionUrls(relayUrl, session.sessionId);
  let websocket;
  let viewer;
  try {
    websocket = new URL(String(session.websocketUrl || ""));
    viewer = new URL(String(session.viewerUrl || ""));
  } catch {
    throw new Error("Managed relay restore state has invalid URLs.");
  }
  const expectedRoot = root.toString("base64url");
  const fragment = new URLSearchParams(viewer.hash.slice(1));
  if (
    websocket.toString() !== expected.websocket.toString() ||
    viewer.protocol !== expected.viewer.protocol ||
    viewer.host !== expected.viewer.host ||
    viewer.pathname !== expected.viewer.pathname ||
    viewer.search ||
    viewer.username ||
    viewer.password ||
    fragment.get("k") !== expectedRoot ||
    [...fragment.keys()].some((key) => key !== "k") ||
    !validHostProtocols(session.subprotocols)
  ) {
    throw new Error("Managed relay restore state does not match the configured relay.");
  }
}

/**
 * @param {object} options
 * @param {string} options.localUrl tokenized loopback live-view URL
 * @param {string} options.apiKey BetterWright account API key
 * @param {string} [options.relayUrl]
 * @param {boolean} [options.interactive]
 * @param {string} [options.clientVersion]
 * @param {object} [options.restore] opaque state from a previous worker
 * @param {(line:string)=>void} [options.log]
 * @param {(state:{reason:string,status:object})=>void|Promise<void>} [options.onTerminal]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {typeof WebSocket} [options.WebSocketImpl]
 */
export function createManagedRelayBridge(options) {
  const localUrl = String(options.localUrl || "");
  const apiKey = String(options.apiKey || "").trim();
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const fetchImpl = options.fetchImpl || fetch;
  const log = options.log || (() => {});
  if (!WebSocketImpl) throw new Error("Managed relay requires Node.js 22 or newer (WebSocket unavailable).");

  let session = options.restore && typeof options.restore === "object" ? { ...options.restore } : null;
  let root = session?.root ? Buffer.from(String(session.root), "base64url") : null;
  let remote = null;
  let local = null;
  let running = false;
  let stopping = false;
  let terminal = false;
  let terminalReason = "";
  let deletionStarted = false;
  let viewerConnected = false;
  let viewerReady = false;
  let challenge = "";
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let hostCipher = null;
  let viewerDecipher = null;
  let lastQuota = session?.quota || null;

  function publicStatus() {
    return {
      ok: true,
      running,
      transport: "relay",
      expose: "relay",
      url: String(session?.viewerUrl || ""),
      sessionId: String(session?.sessionId || ""),
      expiresAt: session?.expiresAt || null,
      interactive: options.interactive !== false,
      viewers: viewerConnected ? 1 : 0,
      quota: lastQuota,
      ...(terminal ? { terminal: true } : {}),
      ...(terminalReason ? { error: terminalReason } : {}),
    };
  }

  function markTerminal(reason) {
    if (terminal) return;
    terminal = true;
    running = false;
    terminalReason = String(reason || "Managed relay session ended.");
    if (!stopping && typeof options.onTerminal === "function") {
      queueMicrotask(() => {
        Promise.resolve(
          options.onTerminal({ reason: terminalReason, status: publicStatus() }),
        ).catch((error) => {
          log(`managed-relay: terminal cleanup failed: ${error?.message || error}`);
        });
      });
    }
  }

  function resetPeerCrypto() {
    hostCipher = createManagedCipher({ root, sessionId: session.sessionId, direction: HOST_TO_VIEWER });
    viewerDecipher = createManagedDecipher({ root, sessionId: session.sessionId, direction: VIEWER_TO_HOST });
    viewerReady = false;
    challenge = randomBase64Url(32);
  }

  function sendEncrypted(type, data) {
    if (!remote || remote.readyState !== WebSocketImpl.OPEN || !hostCipher) return false;
    if (remote.bufferedAmount > REMOTE_BACKPRESSURE_BYTES) return false;
    try {
      const kind =
        type === "text" ? TEXT_PAYLOAD : type === "binary" ? BINARY_PAYLOAD : CHALLENGE_PAYLOAD;
      remote.send(hostCipher.seal(kind, data));
      return true;
    } catch (error) {
      log(`managed-relay: encrypt/send failed: ${error?.message || error}`);
      return false;
    }
  }

  function closeLocal() {
    const socket = local;
    local = null;
    if (socket) {
      try {
        socket.close(1000, "viewer disconnected");
      } catch {
        /* already closed */
      }
    }
  }

  function openLocal() {
    if (!viewerConnected || !viewerReady || local || stopping) return;
    const socket = new WebSocketImpl(localWebSocketUrl(localUrl));
    socket.binaryType = "arraybuffer";
    local = socket;
    socket.addEventListener("message", (event) => {
      if (local !== socket || !viewerConnected || !viewerReady) return;
      if (typeof event.data === "string") sendEncrypted("text", Buffer.from(event.data, "utf8"));
      else sendEncrypted("binary", asBuffer(event.data));
    });
    socket.addEventListener("close", () => {
      if (local === socket) local = null;
    });
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        /* ignored */
      }
    });
  }

  function failEncryptedPeer(reason) {
    log(`managed-relay: ${reason}`);
    try {
      remote?.close(4403, "encrypted channel verification failed");
    } catch {
      /* close event handles cleanup */
    }
  }

  function handleViewerEnvelope(data) {
    if (!viewerDecipher) return;
    let opened;
    try {
      opened = viewerDecipher.open(data);
    } catch (error) {
      failEncryptedPeer(`rejected viewer envelope: ${error?.message || error}`);
      return;
    }
    if (!viewerReady) {
      if (opened.type !== "challenge") {
        failEncryptedPeer("viewer input arrived before root-key verification");
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(opened.data.toString("utf8"));
      } catch {
        failEncryptedPeer("viewer returned an invalid root-key challenge");
        return;
      }
      if (parsed?.t !== "bw_e2e_ready" || !constantEqual(parsed.challenge, challenge)) {
        failEncryptedPeer("viewer failed root-key verification");
        return;
      }
      viewerReady = true;
      challenge = "";
      openLocal();
      return;
    }
    if (opened.type !== "text") {
      failEncryptedPeer("viewer sent an unsupported binary payload");
      return;
    }
    if (local?.readyState === WebSocketImpl.OPEN) local.send(opened.data.toString("utf8"));
  }

  function beginPeer() {
    closeLocal();
    viewerConnected = true;
    resetPeerCrypto();
    if (
      !sendEncrypted(
        "challenge",
        Buffer.from(JSON.stringify({ t: "bw_e2e_challenge", challenge }), "utf8"),
      )
    ) {
      failEncryptedPeer("could not send the root-key challenge");
    }
  }

  function endPeer() {
    viewerConnected = false;
    viewerReady = false;
    challenge = "";
    closeLocal();
    viewerDecipher?.reset();
  }

  function handleControl(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message?.t !== "relay" || typeof message.event !== "string") return;
    if (message.quota && typeof message.quota === "object") lastQuota = message.quota;
    if (message.event === "viewer_connected") {
      beginPeer();
      return;
    }
    if (
      [
        "viewer_disconnected",
        "lease_expired",
        "quota_exhausted",
        "budget_exhausted",
      ].includes(message.event)
    ) {
      endPeer();
      return;
    }
    if (["session_closed", "session_expired", "kill_switch"].includes(message.event)) {
      endPeer();
      markTerminal(`Managed relay ended: ${message.event}.`);
    }
  }

  function scheduleReconnect() {
    if (stopping || terminal || reconnectTimer) return;
    const expiry = Date.parse(String(session?.expiresAt || ""));
    if (Number.isFinite(expiry) && expiry <= Date.now()) {
      markTerminal("Managed relay session expired.");
      return;
    }
    reconnectAttempts += 1;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 1.7 ** Math.min(reconnectAttempts, 8));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectRemote().catch((error) => {
        log(`managed-relay: reconnect failed: ${error?.message || error}`);
        scheduleReconnect();
      });
    }, delay + Math.random() * 250);
    reconnectTimer.unref?.();
  }

  function connectRemote() {
    return new Promise((resolve, reject) => {
      if (stopping || terminal) return reject(new Error("Managed relay session has ended."));
      const socket = new WebSocketImpl(session.websocketUrl, session.subprotocols);
      socket.binaryType = "arraybuffer";
      remote = socket;
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      socket.addEventListener("open", () => {
        if (remote !== socket) return;
        reconnectAttempts = 0;
        running = true;
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      socket.addEventListener("message", (event) => {
        if (remote !== socket) return;
        if (typeof event.data === "string") handleControl(event.data);
        else handleViewerEnvelope(asBuffer(event.data));
      });
      socket.addEventListener("error", () => fail(new Error("Could not connect to the BetterWright relay WebSocket.")));
      socket.addEventListener("close", (event) => {
        if (remote === socket) remote = null;
        running = false;
        endPeer();
        if (TERMINAL_CLOSE_CODES.has(Number(event?.code))) {
          markTerminal(
            event?.reason
              ? `BetterWright relay ended: ${event.reason}.`
              : `BetterWright relay ended with code ${event?.code}.`,
          );
        }
        if (!settled) {
          const detail = event?.reason ? `: ${event.reason}` : "";
          fail(new Error(`BetterWright relay closed during connection${detail}.`));
        }
        if (!stopping && !terminal) scheduleReconnect();
      });
    });
  }

  async function createSession() {
    root = crypto.randomBytes(32);
    const sessionId = `bws_${randomBase64Url(18)}`;
    const viewerProof = deriveManagedViewerProof(root, sessionId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${relayUrl}/v1/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sessionId,
          viewerProof,
          protocolVersion: PROTOCOL_VERSION,
          interactive: options.interactive !== false,
          clientVersion: String(options.clientVersion || "unknown"),
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(responseError(response.status, body));
      // The server now owns this provisional ID. Record it before validating
      // untrusted response fields so a failed start can still DELETE it.
      session = { sessionId };
      const validated = validateSessionResponse(body, relayUrl, sessionId, root);
      session = {
        sessionId,
        websocketUrl: validated.websocketUrl,
        subprotocols: validated.subprotocols,
        viewerUrl: validated.viewerUrl,
        expiresAt: body?.session?.expiresAt || null,
        quota: body?.quota || null,
        root: root.toString("base64url"),
      };
      lastQuota = session.quota;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("Timed out while creating a BetterWright relay session.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function start() {
    if (running) return { ...publicStatus(), alreadyRunning: true, _restore: { ...session } };
    if (terminal || stopping) {
      throw new Error(terminalReason || "Managed relay session has ended.");
    }
    if (!session) await createSession();
    if (root?.length !== 32) throw new Error("Managed relay restore state is invalid.");
    validateRestoreState(session, relayUrl, root);
    await connectRemote();
    return { ...publicStatus(), _restore: { ...session } };
  }

  async function stop({ preserve = false } = {}) {
    stopping = true;
    terminal = true;
    running = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    endPeer();
    const socket = remote;
    remote = null;
    if (socket) {
      try {
        socket.close(1000, preserve ? "worker restarting" : "live view stopped");
      } catch {
        /* already closed */
      }
    }
    if (!preserve && !deletionStarted && session?.sessionId && apiKey) {
      deletionStarted = true;
      let lastError = null;
      for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
        timer.unref?.();
        try {
          const response = await fetchImpl(
            `${relayUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}`,
            {
              method: "DELETE",
              headers: { authorization: `Bearer ${apiKey}` },
              signal: controller.signal,
            },
          );
          if (response.ok || response.status === 404) return;
          lastError = new Error(
            `BetterWright relay session cleanup returned HTTP ${response.status}.`,
          );
          // Authentication and other caller errors are deterministic. Retry
          // only throttling and server-side failures within the shutdown grace.
          if (response.status !== 429 && response.status < 500) throw lastError;
        } catch (error) {
          lastError =
            error?.name === "AbortError"
              ? new Error("Timed out while closing the BetterWright relay session.")
              : error;
          if (
            /HTTP 4\d\d\./.test(String(lastError?.message || "")) &&
            !/HTTP 429\./.test(String(lastError?.message || ""))
          ) {
            throw lastError;
          }
        } finally {
          clearTimeout(timer);
        }
        if (attempt < DELETE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw lastError || new Error("Could not close the BetterWright relay session.");
    }
  }

  return {
    start,
    stop,
    status: publicStatus,
    get restore() {
      return session ? { ...session } : null;
    },
  };
}

export const MANAGED_RELAY_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const MANAGED_RELAY_MAX_ENVELOPE_BYTES = MAX_ENVELOPE_BYTES;
