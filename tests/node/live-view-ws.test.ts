import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  isWebSocketUpgrade,
  upgradeWebSocket,
  webSocketAcceptValue,
} from "../../dist/src/live-view-ws.js";

// RFC 6455 §1.3 sample handshake value.
test("webSocketAcceptValue matches the RFC sample", () => {
  assert.equal(
    webSocketAcceptValue("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});

test("isWebSocketUpgrade requires both headers", () => {
  assert.ok(
    isWebSocketUpgrade({ headers: { upgrade: "websocket", connection: "keep-alive, Upgrade" } }),
  );
  assert.ok(!isWebSocketUpgrade({ headers: { upgrade: "websocket", connection: "keep-alive" } }));
  assert.ok(!isWebSocketUpgrade({ headers: { connection: "Upgrade" } }));
});

function startServer(onConnection) {
  const server = http.createServer((_, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (request, socket) => {
    const connection = upgradeWebSocket(request, socket);
    if (connection) onConnection(connection);
  });
  return new Promise<any>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serverPort(server: http.Server): number {
  // SAFETY: `startServer` resolves only from the callback of a TCP `listen`,
  // so `address()` returns an AddressInfo — not the null of an unbound server
  // or a pipe-name string.
  return (server.address() as AddressInfo).port;
}

function wsUrl(server) {
  return `ws://127.0.0.1:${serverPort(server)}/`;
}

test("echoes text and binary frames with a real WebSocket client", async () => {
  const server = await startServer((connection) => {
    connection.onMessage = ({ type, data }) => {
      if (type === "text") connection.sendText(`echo:${data}`);
      else connection.sendBinary(Buffer.concat([Buffer.from([0xff]), data]));
    };
  });
  try {
    const client = new WebSocket(wsUrl(server));
    client.binaryType = "arraybuffer";
    await once(client, "open");

    const reply = new Promise<any>((resolve) => {
      client.addEventListener("message", (event) => resolve(event.data), { once: true });
    });
    client.send("hello");
    assert.equal(await reply, "echo:hello");

    const binaryReply = new Promise<any>((resolve) => {
      client.addEventListener("message", (event) => resolve(Buffer.from(event.data)), {
        once: true,
      });
    });
    client.send(new Uint8Array([1, 2, 3]));
    assert.deepEqual([...(await binaryReply)], [0xff, 1, 2, 3]);
    client.close();
  } finally {
    server.close();
  }
});

test("large text frames use the 16-bit length path both ways", async () => {
  const payload = "x".repeat(70_000);
  const server = await startServer((connection) => {
    connection.onMessage = ({ data }) => connection.sendText(data);
  });
  try {
    const client = new WebSocket(wsUrl(server));
    await once(client, "open");
    const reply = new Promise<any>((resolve) => {
      client.addEventListener("message", (event) => resolve(event.data), { once: true });
    });
    client.send(payload);
    assert.equal(await reply, payload);
    client.close();
  } finally {
    server.close();
  }
});

test("server close reaches the client with the chosen code", async () => {
  const server = await startServer((connection) => {
    connection.sendText("bye");
    connection.close(4001, "done");
  });
  try {
    const client = new WebSocket(wsUrl(server));
    const closed = new Promise<any>((resolve) => {
      client.addEventListener("close", (event) => resolve(event.code), { once: true });
    });
    assert.equal(await closed, 4001);
  } finally {
    server.close();
  }
});

test("client-initiated close fires onClose with the code and reason", async () => {
  let closeEvent = null;
  const server = await startServer((connection) => {
    connection.onClose = (event) => {
      closeEvent = event;
    };
  });
  try {
    const client = new WebSocket(wsUrl(server));
    await once(client, "open");
    client.close(4009, "user left");
    const deadline = Date.now() + 2_000;
    while (!closeEvent && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closeEvent?.code, 4009);
    assert.equal(closeEvent?.reason, "user left");
  } finally {
    server.close();
  }
});

test("unmasked client frames are rejected as a protocol error", async () => {
  const net = await import("node:net");
  const crypto = await import("node:crypto");
  const server = await startServer(() => {});
  try {
    const socket = net.connect(serverPort(server), "127.0.0.1");
    await once(socket, "connect");
    const key = crypto.randomBytes(16).toString("base64");
    socket.write(
      `GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    // Wait for the 101, then send an unmasked (mask bit clear) text frame.
    const deadline = Date.now() + 2_000;
    while (!Buffer.concat(chunks).toString().includes("\r\n\r\n") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await once(socket, "close");
    const bytes = Buffer.concat(chunks);
    const afterHandshake = bytes.subarray(bytes.indexOf("\r\n\r\n") + 4);
    // A close frame (opcode 8) with code 1002 must have come back.
    assert.equal(afterHandshake[0] & 0x0f, 0x8);
    assert.equal(afterHandshake.readUInt16BE(2), 1002);
  } finally {
    server.close();
  }
});

test("protocol pings from the client are answered with pongs", async () => {
  const net = await import("node:net");
  const crypto = await import("node:crypto");
  const server = await startServer(() => {});
  try {
    const socket = net.connect(serverPort(server), "127.0.0.1");
    await once(socket, "connect");
    const key = crypto.randomBytes(16).toString("base64");
    socket.write(
      `GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    let deadline = Date.now() + 2_000;
    while (!Buffer.concat(chunks).toString().includes("\r\n\r\n") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    chunks.length = 0;
    // Masked ping with payload "hi".
    const mask = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.from("hi");
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index & 3]));
    socket.write(Buffer.concat([Buffer.from([0x89, 0x80 | payload.length]), mask, masked]));
    deadline = Date.now() + 2_000;
    while (Buffer.concat(chunks).length < 4 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = Buffer.concat(chunks);
    assert.equal(reply[0] & 0x0f, 0xa); // pong
    assert.equal(reply.subarray(2).toString(), "hi");
    socket.destroy();
  } finally {
    server.close();
  }
});
