import {
  ENVELOPE_KIND,
  base64UrlToBytes,
  createEnvelopeReceiver,
  createEnvelopeSender,
  deriveViewerProof,
} from "/viewer-crypto.js";

const sessionId = document.querySelector('meta[name="bw-session-id"]')?.content || "";
const hash = new URLSearchParams(location.hash.slice(1));
const rootKey = hash.get("k") || "";
history.replaceState(null, "", location.pathname + location.search);

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const status = document.getElementById("status");
const statusText = status.querySelector("b");
const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlayDetail = document.getElementById("overlay-detail");
const canvas = document.getElementById("screen");
const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
const viewport = document.getElementById("viewport");
const pageUrl = document.getElementById("page-url");
const dimensions = document.getElementById("dimensions");
const tabs = document.getElementById("tabs");
const control = document.getElementById("control");
const handoff = document.getElementById("handoff");
const handoffDetail = document.getElementById("handoff-detail");
const messages = document.getElementById("messages");
const composer = document.getElementById("composer");
const messageInput = document.getElementById("message");
const sendButton = document.getElementById("send");
const toasts = document.getElementById("toasts");

let socket = null;
let viewerProof = "";
let challengeTimer = null;
let trustedHost = false;
let intentionallyEnded = false;
let reconnectAttempts = 0;
let sendChain = Promise.resolve();
let receiveChain = Promise.resolve();
let interactiveAllowed = false;
let controlling = false;
let handoffActive = false;
let askActive = false;
let meta = { deviceWidth: 1280, deviceHeight: 800, url: "" };
let pendingFrame = null;
let decodingFrame = false;
let lastPointer = null;
let pointerTimer = null;
let lastDown = { time: 0, x: 0, y: 0, count: 0 };
const seenMessages = new Set();

function setStatus(kind, text) {
  status.className = `status ${kind}`;
  statusText.textContent = text;
}

function showOverlay(title, detail, terminal = false) {
  overlay.className = terminal ? "overlay active terminal" : "overlay active";
  overlayTitle.textContent = title;
  overlayDetail.textContent = detail;
}

function hideOverlay() {
  overlay.className = "overlay";
}

function toast(text) {
  if (!text) return;
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = String(text).slice(0, 300);
  toasts.appendChild(item);
  setTimeout(() => item.remove(), 4_000);
}

function fatal(title, detail) {
  intentionallyEnded = true;
  trustedHost = false;
  refreshControls();
  setStatus("off", "Disconnected");
  showOverlay(title, detail, true);
  try {
    socket?.close();
  } catch {
    // Socket is already gone.
  }
}

function refreshControls() {
  const canControl = trustedHost && (interactiveAllowed || handoffActive);
  if (!canControl) controlling = false;
  if (handoffActive && canControl) controlling = true;
  control.disabled = !canControl;
  control.textContent = controlling ? "Release control" : "Take control";
  control.className = controlling ? "active" : "";
  canvas.className = controlling ? "controlling" : "";
  handoff.hidden = !handoffActive;
  messageInput.placeholder = askActive ? "Answer the agent" : handoffActive ? "Optional note before resuming" : "Message the agent";
  sendButton.textContent = askActive ? "Answer" : "Send";
}

function websocketUrl() {
  const url = new URL(`/v1/sessions/${sessionId}/ws`, location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function enqueueEnvelope(kind, plaintext, connection = socket, sender = connection?.bwSender) {
  const operation = sendChain.then(async () => {
    if (!connection || socket !== connection || connection.readyState !== WebSocket.OPEN || !sender) return;
    const envelope = await sender.seal(kind, plaintext);
    if (socket === connection && connection.readyState === WebSocket.OPEN) connection.send(envelope);
  });
  sendChain = operation.catch(() => {
    try {
      connection?.close(4403, "encryption failed");
    } catch {
      // Connection teardown is already in progress.
    }
  });
  return operation;
}

function sendProtocol(message) {
  if (!trustedHost) return;
  void enqueueEnvelope(ENVELOPE_KIND.TEXT, encoder.encode(JSON.stringify(message)));
}

async function acceptHostChallenge(plaintext, connection) {
  let value;
  try {
    value = JSON.parse(decoder.decode(plaintext));
  } catch {
    return false;
  }
  if (
    value?.t !== "bw_e2e_challenge" ||
    typeof value.challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.challenge)
  ) {
    return false;
  }
  await enqueueEnvelope(
    ENVELOPE_KIND.CHALLENGE,
    encoder.encode(JSON.stringify({ t: "bw_e2e_ready", challenge: value.challenge })),
    connection,
    connection.bwSender,
  );
  if (socket !== connection || connection.readyState !== WebSocket.OPEN) return false;
  clearTimeout(challengeTimer);
  trustedHost = true;
  reconnectAttempts = 0;
  setStatus("secure", "End-to-end encrypted");
  hideOverlay();
  refreshControls();
  sendProtocol({ t: "refresh" });
  sendViewport();
  sendProtocol({ t: "vis", hidden: document.hidden });
  return true;
}

function renderMeta() {
  pageUrl.textContent = meta.url || "Waiting for the browser";
  dimensions.textContent = `${meta.deviceWidth}×${meta.deviceHeight}`;
}

function renderTabs(items) {
  const fragment = document.createDocumentFragment();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.id !== "string") continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.streaming ? "tab active" : "tab";
    button.disabled = Boolean(item.streaming) || !trustedHost;
    button.textContent = String(item.title || item.url || "about:blank").slice(0, 160);
    button.addEventListener("click", () => {
      sendProtocol({ t: "tab", id: item.id });
      canvas.focus();
    });
    fragment.appendChild(button);
  }
  tabs.replaceChildren(fragment);
}

function appendMessage(entry) {
  if (!entry || typeof entry.text !== "string" || !entry.text) return;
  if (entry.id !== undefined) {
    const key = String(entry.id);
    if (seenMessages.has(key)) return;
    seenMessages.add(key);
    if (seenMessages.size > 500) seenMessages.delete(seenMessages.values().next().value);
  }
  const role = entry.role === "you" ? "you" : entry.role === "system" ? "system" : "agent";
  const row = document.createElement("div");
  row.className = `message ${role}`;
  const label = document.createElement("small");
  label.textContent = role;
  const bubble = document.createElement("p");
  bubble.textContent = entry.text.slice(0, 4_000);
  row.append(label, bubble);
  messages.appendChild(row);
  while (messages.children.length > 100) messages.firstElementChild?.remove();
  messages.scrollTop = messages.scrollHeight;
}

function applyState(value) {
  interactiveAllowed = value?.interactive === true;
  handoffActive = value?.handoff?.active === true;
  askActive = value?.ask?.active === true;
  handoffDetail.textContent = handoffActive ? String(value.handoff.prompt || "Complete the browser step, then resume the agent.") : "";
  if (value?.agent === "driving" && trustedHost) setStatus("busy", "Agent driving");
  else if (trustedHost) setStatus("secure", "End-to-end encrypted");
  refreshControls();
}

function handleProtocolText(plaintext) {
  let value;
  try {
    value = JSON.parse(decoder.decode(plaintext));
  } catch {
    return;
  }
  if (value?.t === "hello" || value?.t === "state") {
    applyState(value);
  } else if (value?.t === "meta") {
    if (Number.isFinite(value.deviceWidth) && value.deviceWidth > 0) meta.deviceWidth = value.deviceWidth;
    if (Number.isFinite(value.deviceHeight) && value.deviceHeight > 0) meta.deviceHeight = value.deviceHeight;
    if (typeof value.url === "string") meta.url = value.url;
    renderMeta();
  } else if (value?.t === "tabs") {
    renderTabs(value.tabs);
  } else if (value?.t === "chat") {
    if (Array.isArray(value.messages)) value.messages.forEach(appendMessage);
    else appendMessage(value.message);
  } else if (value?.t === "toast") {
    toast(value.text);
  } else if (value?.t === "bye") {
    fatal("Live view ended", String(value.reason || "The host stopped this session."));
  }
}

async function paintFrame(bytes) {
  const blob = new Blob([bytes], { type: "image/jpeg" });
  try {
    const bitmap = await createImageBitmap(blob);
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
  } catch {
    // A malformed or superseded image is discarded without exposing its bytes.
  }
}

async function pumpFrames() {
  if (decodingFrame || !pendingFrame || document.hidden) return;
  const frame = pendingFrame;
  pendingFrame = null;
  decodingFrame = true;
  await paintFrame(frame);
  decodingFrame = false;
  if (pendingFrame) void pumpFrames();
}

async function receiveBinary(data, connection, receiver) {
  const opened = await receiver.open(new Uint8Array(data));
  if (!trustedHost) {
    if (opened.kind !== ENVELOPE_KIND.CHALLENGE) {
      throw new Error("application payload arrived before host verification");
    }
    if (!(await acceptHostChallenge(opened.plaintext, connection))) {
      throw new Error("host challenge failed");
    }
    return;
  }
  if (opened.kind === ENVELOPE_KIND.TEXT) {
    handleProtocolText(opened.plaintext);
  } else if (opened.kind === ENVELOPE_KIND.BINARY) {
    pendingFrame = opened.plaintext;
    void pumpFrames();
  } else {
    throw new Error("unexpected challenge after host verification");
  }
}

function connect() {
  if (intentionallyEnded) return;
  setStatus("connecting", reconnectAttempts ? "Reconnecting" : "Securing connection");
  showOverlay(
    reconnectAttempts ? "Reconnecting to the host" : "Opening a private channel",
    "The key stays in this tab and is never sent to the relay.",
  );
  const connection = new WebSocket(websocketUrl(), ["betterwright.relay.v1", `bw.viewer.${viewerProof}`]);
  const receiver = createEnvelopeReceiver(rootKey, sessionId, "h2v");
  connection.bwSender = createEnvelopeSender(rootKey, sessionId, "v2h");
  socket = connection;
  trustedHost = false;
  sendChain = Promise.resolve();
  receiveChain = Promise.resolve();
  connection.binaryType = "arraybuffer";
  connection.addEventListener("open", () => {
    refreshControls();
    clearTimeout(challengeTimer);
    challengeTimer = setTimeout(() => {
      try {
        connection.close(4403, "host challenge timed out");
      } catch {
        // Socket is already gone.
      }
    }, 10_000);
  });
  connection.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      connection.close(4415, "unexpected plaintext from relay");
      return;
    }
    receiveChain = receiveChain.then(() => receiveBinary(event.data, connection, receiver)).catch(() => {
      try {
        connection.close(4403, "encrypted channel verification failed");
      } catch {
        // Connection is already closing.
      }
    });
  });
  connection.addEventListener("close", (event) => {
    if (socket !== connection) return;
    clearTimeout(challengeTimer);
    trustedHost = false;
    refreshControls();
    if (intentionallyEnded) return;
    const terminalCodes = new Set([4401, 4403, 4407, 4408, 4411, 4412, 4414, 4415, 4416]);
    if (terminalCodes.has(event.code)) {
      fatal("Live view unavailable", event.reason || "The relay rejected this connection.");
      return;
    }
    reconnectAttempts += 1;
    if (reconnectAttempts > 90) {
      fatal("Host unreachable", "The live view could not reconnect after 15 minutes.");
      return;
    }
    const base = event.code === 4413 ? 150 : Math.min(10_000, 500 * 1.55 ** Math.min(reconnectAttempts, 8));
    const delay = base + Math.random() * 250;
    setTimeout(connect, delay);
  });
  connection.addEventListener("error", () => {
    try {
      connection.close();
    } catch {
      // Close event handles retry.
    }
  });
}

function scaleCoordinates(event) {
  const rect = canvas.getBoundingClientRect();
  const bitmapAspect = canvas.width > 0 && canvas.height > 0 ? canvas.width / canvas.height : rect.width / rect.height;
  const width = Math.min(rect.width, rect.height * bitmapAspect);
  const height = width / bitmapAspect;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  return {
    x: Math.round(Math.min(Math.max(((event.clientX - left) / width) * meta.deviceWidth, 0), meta.deviceWidth) * 100) / 100,
    y: Math.round(Math.min(Math.max(((event.clientY - top) / height) * meta.deviceHeight, 0), meta.deviceHeight) * 100) / 100,
  };
}

function modifiers(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

const buttonNames = ["left", "middle", "right", "back", "forward"];
function sendMouse(type, event, extra = {}) {
  if (!trustedHost || !controlling) return;
  const point = scaleCoordinates(event);
  sendProtocol({
    t: "input",
    kind: "mouse",
    type,
    x: point.x,
    y: point.y,
    button: buttonNames[event.button] || "none",
    buttons: event.buttons || 0,
    modifiers: modifiers(event),
    clickCount: extra.clickCount || 0,
    ...(extra.deltaX === undefined ? {} : { deltaX: extra.deltaX, deltaY: extra.deltaY }),
  });
}

control.addEventListener("click", () => {
  controlling = !controlling;
  if (controlling) canvas.focus();
  refreshControls();
});

canvas.addEventListener("pointerdown", (event) => {
  if (!controlling) return;
  event.preventDefault();
  canvas.focus();
  const point = scaleCoordinates(event);
  const now = Date.now();
  lastDown.count = now - lastDown.time < 400 && Math.abs(point.x - lastDown.x) < 6 && Math.abs(point.y - lastDown.y) < 6
    ? lastDown.count + 1
    : 1;
  lastDown = { time: now, x: point.x, y: point.y, count: lastDown.count };
  sendMouse("mousePressed", event, { clickCount: lastDown.count });
});
canvas.addEventListener("pointerup", (event) => {
  if (!controlling) return;
  event.preventDefault();
  sendMouse("mouseReleased", event, { clickCount: lastDown.count || 1 });
});
canvas.addEventListener("pointermove", (event) => {
  if (!controlling) return;
  lastPointer = event;
  if (pointerTimer) return;
  pointerTimer = setTimeout(() => {
    pointerTimer = null;
    const pending = lastPointer;
    lastPointer = null;
    if (pending) sendMouse("mouseMoved", pending);
  }, 70);
});
canvas.addEventListener("wheel", (event) => {
  if (!controlling) return;
  event.preventDefault();
  sendMouse("mouseWheel", event, { deltaX: event.deltaX, deltaY: event.deltaY });
}, { passive: false });
canvas.addEventListener("contextmenu", (event) => {
  if (controlling) event.preventDefault();
});

function uiFocused() {
  const active = document.activeElement;
  return active && active !== canvas && active !== document.body;
}

window.addEventListener("keydown", (event) => {
  if (!controlling || uiFocused()) return;
  event.preventDefault();
  sendProtocol({
    t: "input",
    kind: "key",
    type: "keyDown",
    key: event.key,
    code: event.code,
    keyCode: event.keyCode || 0,
    modifiers: modifiers(event),
    ...(event.key === "Enter" ? { text: "\r" } : event.key.length === 1 && !event.ctrlKey && !event.metaKey ? { text: event.key } : {}),
  });
});
window.addEventListener("keyup", (event) => {
  if (!controlling || uiFocused()) return;
  event.preventDefault();
  sendProtocol({
    t: "input",
    kind: "key",
    type: "keyUp",
    key: event.key,
    code: event.code,
    keyCode: event.keyCode || 0,
    modifiers: modifiers(event),
  });
});
window.addEventListener("paste", (event) => {
  if (!controlling || uiFocused()) return;
  const text = event.clipboardData?.getData("text") || "";
  if (text) sendProtocol({ t: "input", kind: "insertText", text: text.slice(0, 8_192) });
  event.preventDefault();
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !trustedHost) return;
  sendProtocol({ t: askActive ? "answer" : "chat", text });
  messageInput.value = "";
});
document.getElementById("done").addEventListener("click", () => {
  sendProtocol({ t: "done", note: messageInput.value.trim() });
  messageInput.value = "";
});
document.getElementById("cancel").addEventListener("click", () => {
  sendProtocol({ t: "cancel", note: messageInput.value.trim() });
  messageInput.value = "";
});

function sendViewport() {
  if (!trustedHost) return;
  const rect = viewport.getBoundingClientRect();
  const pixels = Math.ceil(Math.max(rect.width, rect.height) * (devicePixelRatio || 1));
  if (pixels > 0) sendProtocol({ t: "view", px: pixels });
}
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendViewport, 300);
});
document.addEventListener("visibilitychange", () => {
  sendProtocol({ t: "vis", hidden: document.hidden });
  if (!document.hidden) void pumpFrames();
});

async function start() {
  try {
    base64UrlToBytes(rootKey, 32);
    if (!/^bws_[A-Za-z0-9_-]{24}$/.test(sessionId)) throw new Error("invalid session");
    viewerProof = await deriveViewerProof(rootKey, sessionId);
    renderMeta();
    refreshControls();
    connect();
  } catch {
    fatal("Invalid private link", "This URL is missing a valid 32-byte #k root key. Ask for a fresh viewer link.");
  }
}

void start();
