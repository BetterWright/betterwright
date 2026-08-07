import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  cookiesFromSetCookie,
  requestSiteResponse,
} from "../../dist/src/site-request.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function tunnelProxy() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    let pending = Buffer.alloc(0);
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const boundary = pending.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      client.off("data", onData);
      const first = pending.subarray(0, boundary).toString("latin1").split("\r\n", 1)[0];
      const authority = /^CONNECT\s+([^\s]+)\s+HTTP\/1\.[01]$/i.exec(first)?.[1] || "";
      const separator = authority.lastIndexOf(":");
      const host = authority.slice(0, separator).replace(/^\[|\]$/g, "");
      const port = Number(authority.slice(separator + 1));
      const upstream = net.createConnection({ host, port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remainder = pending.subarray(boundary + 4);
        if (remainder.length) upstream.write(remainder);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.once("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  return { server, sockets };
}

test("site transport stops buffering after the response limit", async () => {
  const origin = http.createServer((request, response) => {
    if (request.url === "/large") {
      response.writeHead(200, { "content-type": "text/plain" });
      for (let index = 0; index < 128; index += 1) response.write("x".repeat(16_384));
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "trial=ready; HttpOnly; SameSite=Strict; Path=/app",
    });
    response.end('{"ok":true}');
  });
  const { server: proxy, sockets } = tunnelProxy();
  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  try {
    const large = await requestSiteResponse({
      target: `http://127.0.0.1:${originPort}/large`,
      proxyPort,
      method: "GET",
      headers: { "accept-encoding": "identity" },
      timeoutMs: 5_000,
      limit: 1_024,
    });
    assert.equal(large.truncated, true);
    assert.equal(large.bytes.length, 1_024);

    const small = await requestSiteResponse({
      target: `http://127.0.0.1:${originPort}/small`,
      proxyPort,
      method: "GET",
      headers: { "accept-encoding": "identity" },
      timeoutMs: 5_000,
      limit: 1_024,
    });
    assert.equal(small.truncated, false);
    assert.equal(small.bytes.toString("utf8"), '{"ok":true}');
    assert.deepEqual(
      cookiesFromSetCookie(small.setCookie, `http://127.0.0.1:${originPort}/small`),
      [{
        name: "trial",
        value: "ready",
        domain: "127.0.0.1",
        path: "/app",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Strict",
      }],
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(proxy), close(origin)]);
  }
});
