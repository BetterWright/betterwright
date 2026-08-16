#!/usr/bin/env node
// CDP-free premise probe.
//
// Launches a browser binary DIRECTLY (no Playwright, no DevTools protocol —
// the only control channel is the MV3 bridge extension over loopback
// WebSocket), navigates to the reCAPTCHA v3 score demo, and reads the
// server-verified score through chrome.scripting. This is a control-plane
// comparison probe, not the production BetterWright runtime.
//
// Usage:
//   node research/cdpfree-probe.js [--browser /path/to/binary] [--headed]
//   node research/cdpfree-probe.js --url https://example.com --selector h1

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT_BUILD = path.join(ROOT, "dist", "src", "cdpfree", "extension");

function managedBrowserPath() {
  // The managed BetterChromium fork installed by `betterwright setup`.
  const root = path.join(os.homedir(), ".betterwright", "chromium");
  const candidates = [
    path.join(
      root,
      "mac-arm64",
      "BetterChromium.app",
      "Contents",
      "MacOS",
      "BetterChromium",
    ),
    path.join(root, "linux-x64", "betterchromium"),
    path.join(root, "win-x64", "betterchromium.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const args = process.argv.slice(2);
function flagValue(flag, fallback = null) {
  const index = args.indexOf(flag);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
}
const TARGET_URL =
  flagValue("--url") ||
  "https://antcpt.com/score_detector/";
const TARGET_SELECTOR = flagValue(
  "--selector",
  ".well .col-md-6 big",
);
const SCORE_PATTERN = flagValue("--score-pattern") || "([0-9][.][0-9])";
const READ_VALUE = args.includes("--value");
const TOKEN_MODE = args.includes("--token");
const KEEP_ARTIFACTS = args.includes("--keep");
const HEADED = args.includes("--headed");
const HEADLESS = args.includes("--headless");
const PLAIN_LAUNCH = args.includes("--plain");
const OPEN_IN_NEW_TAB = args.includes("--new-tab");
const STARTUP_NAVIGATION = args.includes("--startup-url");
const INITIAL_WAIT_MS = Number(flagValue("--initial-wait", "0")) * 1_000;
const POLL_ATTEMPTS = Number(flagValue("--poll-attempts", "25"));
const BROWSER =
  flagValue("--browser") ||
  managedBrowserPath() ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// --- minimal RFC6455 server (text frames only, zero deps) --------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

function wsEncodeText(text) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Parse complete frames from a buffer; returns [frames, rest]. */
function wsParseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (cursor + maskLength + length > buffer.length) break;
    let payload = buffer.subarray(cursor + maskLength, cursor + maskLength + length);
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      const unmasked = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
      payload = unmasked;
    }
    frames.push({ opcode, payload });
    offset = cursor + maskLength + length;
  }
  return [frames, buffer.subarray(offset)];
}

function upgradeWebSocket(request, socket, onMessage, onClose) {
  const key = request.headers["sec-websocket-key"];
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const [frames, rest] = wsParseFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        socket.end();
        onClose();
      } else if (frame.opcode === 0x9) {
        // ping -> pong
        const pong = Buffer.concat([
          Buffer.from([0x8a, frame.payload.length]),
          frame.payload,
        ]);
        socket.write(pong);
      } else if (frame.opcode === 0x1) {
        onMessage(frame.payload.toString("utf8"));
      }
    }
  });
  socket.on("close", onClose);
  socket.on("error", () => onClose());
  return {
    send: (text) => socket.write(wsEncodeText(text)),
    close: () => socket.end(),
  };
}

const token = crypto.randomBytes(16).toString("hex");
let bridgeSocket = null;
let nextId = 1;
const pending = new Map();

const server = http.createServer();
server.on("upgrade", (request, socket) => {
  if (!request.url?.startsWith("/bridge")) {
    socket.destroy();
    return;
  }
  const ws = upgradeWebSocket(
    request,
    socket,
    (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.hello) {
        if (message.token !== token) {
          ws.close();
          return;
        }
        bridgeSocket = ws;
        console.error("[bridge] extension connected");
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message);
    },
    () => {
      if (bridgeSocket === ws) bridgeSocket = null;
    },
  );
});

const port = await new Promise<number>((resolve) => {
  // SAFETY: inside the listen callback the server is bound to a TCP port, so
  // address() returns an AddressInfo object, never null or a pipe name string.
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
});

// The op-specific arguments the bridge extension understands, spread into the
// wire message beside `id` and `op`.
interface RpcPayload {
  url?: string;
  tabId?: number | null;
  selector?: string;
  timeoutMs?: number;
}

function rpc(op, payload: RpcPayload = {}, timeoutMs = 60_000): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    if (!bridgeSocket) return reject(new Error("bridge not connected"));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`rpc ${op} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    bridgeSocket.send(JSON.stringify({ id, op, ...payload }));
  });
}

async function waitForBridge(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bridgeSocket) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("extension bridge never connected");
}

// --- generated extension dir -------------------------------------------------

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bw-cdpfree-"));
const extDir = path.join(tmpHome, "ext");
fs.mkdirSync(extDir, { recursive: true });
if (!fs.existsSync(path.join(EXT_BUILD, "background.js"))) {
  throw new Error("CDP-free extension is not built; run `npm run build` first");
}
for (const file of ["manifest.json", "background.js"]) {
  fs.copyFileSync(path.join(EXT_BUILD, file), path.join(extDir, file));
}
fs.writeFileSync(
  path.join(extDir, "config.js"),
  `const BW_BRIDGE_CONFIG = ${JSON.stringify({ port, token })};\n`,
);

// --- launch the browser directly (no CDP anywhere) ---------------------------

const profileDir = path.join(tmpHome, "profile");
const browserArgs = [
  `--user-data-dir=${profileDir}`,
  `--load-extension=${extDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
];
if (!BROWSER.includes("Google Chrome.app")) {
  browserArgs.push(`--disable-extensions-except=${extDir}`);
}
if (!PLAIN_LAUNCH) {
  browserArgs.push(
    "--test-type",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    `--fingerprint=${crypto.randomInt(10_000, 100_000)}`,
    "--fingerprint-platform=macos",
    "--lang=en-US",
    "--fingerprint-locale=en-US",
    `--fingerprint-timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  );
}
if (HEADLESS) browserArgs.push("--headless=new", "--window-size=1920,923");
if (!HEADED && !HEADLESS) browserArgs.push("--window-position=32000,32000");
browserArgs.push(STARTUP_NAVIGATION ? TARGET_URL : "about:blank");

console.error(`[launch] ${BROWSER}`);
console.error(`[mode] ${HEADLESS ? "headless=new" : HEADED ? "headed" : "headed offscreen"}`);
const child = spawn(BROWSER, browserArgs, { stdio: "ignore" });
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    child.kill("SIGKILL");
  } catch {}
  server.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// --- run the probe -------------------------------------------------------------

try {
  await waitForBridge();
  console.error(`[nav] ${STARTUP_NAVIGATION ? "startup" : TARGET_URL}`);
  let targetTabId = null;
  if (STARTUP_NAVIGATION) {
    await rpc("waitLoad", { timeoutMs: 45_000 });
  } else if (OPEN_IN_NEW_TAB) {
    const created = await rpc("newTab", { url: TARGET_URL });
    targetTabId = created.tabId;
    await rpc("waitLoad", { tabId: targetTabId, timeoutMs: 45_000 });
  } else {
    await rpc("navigate", { url: TARGET_URL, timeoutMs: 45_000 });
  }

  // Wait for the demo's server verdict to render, reading exclusively through
  // the extension bus.
  let verdict = null;
  if (INITIAL_WAIT_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, INITIAL_WAIT_MS));
  }
  for (let attempt = 0; attempt < POLL_ATTEMPTS && !verdict; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const result = await rpc(READ_VALUE ? "queryValue" : "queryText", {
      tabId: targetTabId,
      selector: TARGET_SELECTOR,
    });
    verdict = result.value;
  }
  if (!verdict) {
    console.log(JSON.stringify({ score: null, verdict: "TIMEOUT" }, null, 2));
    // Every other exit path cleans up; without this the timeout leaks the
    // spawned browser and its temp profile.
    cleanup();
    process.exit(1);
  }
  let score = null;
  try {
    score = JSON.parse(verdict).score;
  } catch {
    if (SCORE_PATTERN) {
      const match = verdict.match(new RegExp(SCORE_PATTERN));
      if (match?.[1]) score = Number(match[1]);
    }
  }
  if (TOKEN_MODE) {
    console.log(
      JSON.stringify(
        { tokenIssued: verdict.length > 20, tokenLength: verdict.length },
        null,
        2,
      ),
    );
    cleanup();
    process.exit(verdict.length > 20 ? 0 : 1);
  }
  console.error(`[verdict] ${verdict}`);
  let parsedVerdict = verdict;
  try {
    parsedVerdict = JSON.parse(verdict);
  } catch {
    /* plain-text verdict */
  }
  console.log(JSON.stringify({ score, verdict: parsedVerdict }, null, 2));
  cleanup();
  process.exit(0);
} catch (error) {
  console.error(`[fail] ${error.message}`);
  if (KEEP_ARTIFACTS) {
    console.error(`[keep] ${tmpHome}`);
    child.kill("SIGKILL");
    server.close();
    cleaned = true;
  } else {
    cleanup();
  }
  process.exit(1);
}
