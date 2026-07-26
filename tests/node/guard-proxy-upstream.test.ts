import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import net from "node:net";
import test from "node:test";

import {
  createGuardProxy,
  httpGetViaProxy,
  parseUpstreamProxy,
} from "../../dist/src/guard-proxy.js";

function socksGreeting(client) {
  client.write(Buffer.from([5, 1, 0]));
  return readExact(client, 2);
}

function readExact(socket, minimum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => finish(new Error("timed out reading socket")), 3_000);
    const finish = (error, value?) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length >= minimum) finish(null, Buffer.concat(chunks, length).subarray(0, minimum));
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("socket closed early"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function socksRequest(client, host, port = 443) {
  const encoded = Buffer.from(host, "utf8");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  client.write(
    Buffer.concat([Buffer.from([5, 1, 0, 3, encoded.length]), encoded, portBytes]),
  );
  const reply = await readExact(client, 10);
  return reply[1];
}

function guardOptions(overrides = {}) {
  return {
    guardUrl: async () => ({ allowed: true }),
    executeId: () => "upstream-test",
    transport: {},
    ...overrides,
  };
}

/** Mock HTTP CONNECT upstream; records the CONNECT authority it received. */
async function startHttpUpstream({
  accept = true,
  requireAuth = null,
  responseBody = null,
} = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let established = false;
    socket.on("data", (chunk) => {
      if (established) {
        if (responseBody == null) {
          // Echo server: anything the browser sends comes straight back.
          socket.write(chunk);
        } else {
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`,
          );
        }
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString("latin1");
      const [requestLine, ...headerLines] = head.split("\r\n");
      const authority = requestLine.split(" ")[1];
      const authHeader = headerLines.find((line) =>
        line.toLowerCase().startsWith("proxy-authorization:"),
      );
      received.push({ authority, authHeader: authHeader || null });
      const rest = buffer.subarray(end + 4);
      buffer = Buffer.alloc(0);
      if (requireAuth) {
        const expected = `Proxy-Authorization: Basic ${Buffer.from(requireAuth).toString("base64")}`;
        if (authHeader !== expected) {
          socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
          return;
        }
      }
      if (!accept) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      established = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) socket.write(rest);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, received, port: (server.address() as AddressInfo).port };
}

/** Mock SOCKS5 upstream with optional username/password auth. */
async function startSocks5Upstream({
  username = null,
  password = null,
  responseBody = null,
} = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    let stage = "greeting";
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (stage === "relay") {
        if (responseBody == null) {
          socket.write(chunk);
        } else {
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`,
          );
        }
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        const wantsAuth = Boolean(username);
        socket.write(Buffer.from([5, wantsAuth ? 2 : 0]));
        buffer = buffer.subarray(2 + buffer[1]);
        stage = wantsAuth ? "auth" : "request";
        if (wantsAuth && buffer.length === 0) return;
      }
      if (stage === "auth") {
        if (buffer.length < 2) return;
        const ulen = buffer[1];
        if (buffer.length < 2 + ulen + 1) return;
        const user = buffer.subarray(2, 2 + ulen).toString("utf8");
        const plen = buffer[2 + ulen];
        if (buffer.length < 2 + ulen + 1 + plen) return;
        const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
        socket.write(
          Buffer.from([1, user === username && pass === password ? 0 : 1]),
        );
        buffer = buffer.subarray(3 + ulen + plen);
        stage = "request";
        if (buffer.length === 0) return;
      }
      if (stage === "request") {
        if (buffer.length < 10) return;
        const atyp = buffer[3];
        let host;
        if (atyp === 1) host = buffer.subarray(4, 8).join(".");
        else if (atyp === 3) host = buffer.subarray(5, 5 + buffer[4]).toString("utf8");
        else host = "ipv6";
        const port = buffer.readUInt16BE(atyp === 3 ? 7 + buffer[4] - 2 : 8);
        received.push({ host, port, atyp });
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        buffer = Buffer.alloc(0);
        stage = "relay";
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, received, port: (server.address() as AddressInfo).port };
}

test("parseUpstreamProxy parses http/socks5 with auth", () => {
  assert.deepEqual(parseUpstreamProxy("http://proxy.local:8080"), {
    protocol: "http",
    host: "proxy.local",
    port: 8080,
    username: "",
    password: "",
  });
  assert.deepEqual(parseUpstreamProxy("socks5://user:p%40ss@10.0.0.9:1080"), {
    protocol: "socks5",
    host: "10.0.0.9",
    port: 1080,
    username: "user",
    password: "p@ss",
  });
  assert.equal(parseUpstreamProxy("socks5h://proxy.local")?.port, 1080);
  assert.equal(parseUpstreamProxy("ftp://nope"), null);
  assert.equal(parseUpstreamProxy("not a url"), null);
  assert.equal(parseUpstreamProxy(null), null);
});

test("geo lookup tunnels through an HTTP upstream", async () => {
  const body = JSON.stringify({ status: "success", countryCode: "SG" });
  const upstream = await startHttpUpstream({ responseBody: body });
  try {
    const response = await httpGetViaProxy(
      parseUpstreamProxy(`http://127.0.0.1:${upstream.port}`),
      "http://geo.example/lookup",
    );
    assert.equal(response.status, 200);
    assert.equal(response.body, body);
    assert.equal(upstream.received[0].authority, "geo.example:80");
  } finally {
    upstream.server.close();
  }
});

test("geo lookup uses the SOCKS5 handshake and credentials", async () => {
  const body = JSON.stringify({ status: "success", countryCode: "DE" });
  const upstream = await startSocks5Upstream({
    username: "geo",
    password: "secret",
    responseBody: body,
  });
  try {
    const response = await httpGetViaProxy(
      parseUpstreamProxy(`socks5://geo:secret@127.0.0.1:${upstream.port}`),
      "http://geo.example/lookup",
    );
    assert.equal(response.status, 200);
    assert.equal(response.body, body);
    assert.deepEqual(upstream.received[0], {
      host: "geo.example",
      port: 80,
      atyp: 3,
    });
  } finally {
    upstream.server.close();
  }
});

test("guard tunnels through an HTTP upstream to the validated literal IP", async () => {
  const upstream = await startHttpUpstream();
  const guard = createGuardProxy(
    guardOptions({
      transport: {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      upstreamProxy: parseUpstreamProxy(`http://127.0.0.1:${upstream.port}`),
    }),
  );
  try {
    const port = await guard.ensure();
    const client = net.createConnection({ host: "127.0.0.1", port });
    await once(client, "connect");
    await socksGreeting(client);
    const code = await socksRequest(client, "example.com", 443);
    assert.equal(code, 0, "guard reports success");
    client.write("ping-through-upstream");
    const echoed = await readExact(client, 21);
    assert.equal(echoed.toString(), "ping-through-upstream");
    client.destroy();
    // The upstream saw CONNECT to the validated literal — never the hostname.
    assert.equal(upstream.received[0].authority, "93.184.216.34:443");
  } finally {
    await guard.close();
    upstream.server.close();
  }
});

test("HTTP upstream forwards proxy credentials", async () => {
  const upstream = await startHttpUpstream({ requireAuth: "alice:s3cret" });
  const guard = createGuardProxy(
    guardOptions({
      transport: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      upstreamProxy: parseUpstreamProxy(
        `http://alice:s3cret@127.0.0.1:${upstream.port}`,
      ),
    }),
  );
  try {
    const port = await guard.ensure();
    const client = net.createConnection({ host: "127.0.0.1", port });
    await once(client, "connect");
    await socksGreeting(client);
    assert.equal(await socksRequest(client, "example.com"), 0);
    assert.match(upstream.received[0].authHeader, /^Proxy-Authorization: Basic /);
    client.destroy();
  } finally {
    await guard.close();
    upstream.server.close();
  }
});

test("SOCKS5 upstream with auth tunnels to the literal IP", async () => {
  const upstream = await startSocks5Upstream({ username: "bob", password: "hunter2" });
  const guard = createGuardProxy(
    guardOptions({
      transport: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      upstreamProxy: parseUpstreamProxy(`socks5://bob:hunter2@127.0.0.1:${upstream.port}`),
    }),
  );
  try {
    const port = await guard.ensure();
    const client = net.createConnection({ host: "127.0.0.1", port });
    await once(client, "connect");
    await socksGreeting(client);
    assert.equal(await socksRequest(client, "example.com"), 0);
    client.write("relay-me");
    assert.equal((await readExact(client, 8)).toString(), "relay-me");
    assert.equal(upstream.received[0].host, "93.184.216.34");
    client.destroy();
  } finally {
    await guard.close();
    upstream.server.close();
  }
});

test("upstream refusal surfaces as a SOCKS failure to the browser", async () => {
  const upstream = await startHttpUpstream({ accept: false });
  const guard = createGuardProxy(
    guardOptions({
      transport: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      upstreamProxy: parseUpstreamProxy(`http://127.0.0.1:${upstream.port}`),
    }),
  );
  try {
    const port = await guard.ensure();
    const client = net.createConnection({ host: "127.0.0.1", port });
    await once(client, "connect");
    await socksGreeting(client);
    const code = await socksRequest(client, "example.com");
    assert.notEqual(code, 0, "guard reports failure");
    client.destroy();
  } finally {
    await guard.close();
    upstream.server.close();
  }
});

test("policy blocks still apply before any upstream connection", async () => {
  const upstream = await startHttpUpstream();
  const guard = createGuardProxy(
    guardOptions({
      guardUrl: async () => ({ allowed: false, reason: "blocked test host" }),
      transport: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      upstreamProxy: parseUpstreamProxy(`http://127.0.0.1:${upstream.port}`),
    }),
  );
  try {
    const port = await guard.ensure();
    const client = net.createConnection({ host: "127.0.0.1", port });
    await once(client, "connect");
    await socksGreeting(client);
    assert.equal(await socksRequest(client, "blocked.example"), 2);
    assert.equal(upstream.received.length, 0, "upstream never contacted");
    client.destroy();
  } finally {
    await guard.close();
    upstream.server.close();
  }
});
