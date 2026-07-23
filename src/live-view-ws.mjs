// Minimal RFC 6455 WebSocket server for the live-view relay.
//
// BetterWright hand-rolls its protocol servers (see guard-proxy.mjs for the
// SOCKS5 guard) instead of adding dependencies, and Node's built-in WebSocket
// is client-only. This module implements exactly the subset the live viewer
// needs: the upgrade handshake, unfragmented text/binary frames, ping/pong,
// and close. Fragmented client frames are rejected — the viewer only sends
// small JSON control messages, never payloads worth fragmenting.

import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// Largest client→server payload accepted. Viewer messages are tiny JSON; a
// larger frame indicates a broken or hostile peer.
const MAX_CLIENT_PAYLOAD = 256 * 1024;

export function webSocketAcceptValue(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}${WS_GUID}`)
    .digest("base64");
}

export function isWebSocketUpgrade(request) {
  const upgrade = String(request.headers.upgrade || "").toLowerCase();
  const connection = String(request.headers.connection || "").toLowerCase();
  return upgrade === "websocket" && connection.includes("upgrade");
}

/**
 * Pre-encode a binary payload into a complete WebSocket frame so a broadcast
 * to N viewers serializes the (potentially large) JPEG once, not N times.
 * Send the result with connection.sendRaw().
 */
export function encodeBinaryFrame(payload) {
  return encodeFrame(OP_BINARY, payload);
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN, no extensions
  return Buffer.concat([header, payload]);
}

/**
 * Complete the WebSocket handshake on an HTTP upgrade and return a connection.
 *
 * The caller has already authenticated the request (token, origin); this
 * only speaks the wire protocol. Returns null (socket destroyed) when the
 * request is not a well-formed upgrade.
 */
export function upgradeWebSocket(request, socket) {
  const key = String(request.headers["sec-websocket-key"] || "").trim();
  const version = String(request.headers["sec-websocket-version"] || "").trim();
  if (!isWebSocketUpgrade(request) || !key || version !== "13") {
    socket.destroy();
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${webSocketAcceptValue(key)}\r\n` +
      "\r\n",
  );
  socket.setNoDelay(true);

  let buffered = Buffer.alloc(0);
  let open = true;
  let closeSent = false;

  const connection = {
    onMessage: null, // ({ type: "text"|"binary", data }) => void
    onClose: null, // ({ code, reason }) => void
    onPong: null, // () => void
    get bufferedAmount() {
      return socket.writableLength;
    },
    get isOpen() {
      return open;
    },
    sendText(text) {
      if (!open) return;
      socket.write(encodeFrame(OP_TEXT, Buffer.from(String(text), "utf8")));
    },
    sendBinary(data) {
      if (!open) return;
      socket.write(encodeFrame(OP_BINARY, data));
    },
    sendRaw(frame) {
      // A frame already encoded with encodeBinaryFrame(); shared by broadcast.
      if (!open) return;
      socket.write(frame);
    },
    ping() {
      if (!open) return;
      socket.write(encodeFrame(OP_PING, Buffer.alloc(0)));
    },
    close(code = 1000, reason = "") {
      if (open && !closeSent) {
        closeSent = true;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        try {
          socket.write(encodeFrame(OP_CLOSE, body));
        } catch {
          /* peer already gone */
        }
      }
      socket.end();
    },
    destroy() {
      socket.destroy();
    },
  };

  const finish = (code, reason) => {
    if (!open) return;
    open = false;
    try {
      connection.onClose?.({ code, reason });
    } catch {
      /* close handlers must never throw into the socket path */
    }
  };

  const fail = (code, reason) => {
    connection.close(code, reason);
    finish(code, reason);
    socket.destroy();
  };

  socket.on("data", (chunk) => {
    if (!open) return;
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (open) {
      if (buffered.length < 2) return;
      const first = buffered[0];
      const second = buffered[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;
      if (rsv !== 0) return fail(1002, "reserved bits set");
      if (!masked) return fail(1002, "client frames must be masked");
      if (!fin || opcode === OP_CONTINUATION) {
        return fail(1003, "fragmented frames are not supported");
      }
      if (payloadLength === 126) {
        if (buffered.length < offset + 2) return;
        payloadLength = buffered.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buffered.length < offset + 8) return;
        const big = buffered.readBigUInt64BE(offset);
        if (big > BigInt(MAX_CLIENT_PAYLOAD)) return fail(1009, "frame too large");
        payloadLength = Number(big);
        offset += 8;
      }
      if (payloadLength > MAX_CLIENT_PAYLOAD) return fail(1009, "frame too large");
      if (buffered.length < offset + 4 + payloadLength) return;
      const mask = buffered.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.allocUnsafe(payloadLength);
      for (let i = 0; i < payloadLength; i += 1) {
        payload[i] = buffered[offset + i] ^ mask[i & 3];
      }
      buffered = buffered.subarray(offset + payloadLength);

      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        try {
          connection.onMessage?.({
            type: opcode === OP_TEXT ? "text" : "binary",
            data: opcode === OP_TEXT ? payload.toString("utf8") : payload,
          });
        } catch {
          /* a handler error must not kill the connection loop */
        }
      } else if (opcode === OP_PING) {
        if (open) socket.write(encodeFrame(OP_PONG, payload));
      } else if (opcode === OP_PONG) {
        try {
          connection.onPong?.();
        } catch {
          /* ignore */
        }
      } else if (opcode === OP_CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        connection.close(code < 1000 || code > 4999 ? 1000 : code, "");
        finish(code, reason);
        socket.destroy();
        return;
      } else {
        return fail(1002, `unsupported opcode ${opcode}`);
      }
    }
  });
  socket.on("error", () => finish(1006, "socket error"));
  socket.on("close", () => finish(1006, "socket closed"));

  return connection;
}
