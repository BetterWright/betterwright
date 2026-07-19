import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import { createGuardProxy } from "../../src/guard-proxy.mjs";

// Drive the proxy as a real SOCKS5 client: greeting, CONNECT to `host:port`
// (hostname form), resolve with the reply code once it arrives.
function socksConnect(proxyPort, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort });
    let greeted = false;
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (data) => {
      if (!greeted) {
        greeted = true;
        const request = Buffer.alloc(7 + host.length);
        request.set([5, 1, 0, 3, host.length]);
        request.write(host, 5);
        request.writeUInt16BE(port, 5 + host.length);
        socket.write(request);
        return;
      }
      socket.destroy();
      resolve(data[1]);
    });
    socket.on("error", reject);
  });
}

async function withProxy(guardUrl, run) {
  const proxy = createGuardProxy({
    guardUrl,
    executeId: () => "test",
  });
  const port = await proxy.ensure();
  try {
    return await run(port);
  } finally {
    await proxy.close();
  }
}

const allowAll = async () => ({ allowed: true });

// A listener that immediately refuses nothing but is closed before use gives a
// deterministic local connection failure (ECONNREFUSED) with no network access.
async function refusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("repeated failing CONNECTs to one target back off", async () => {
  const port = await refusedPort();
  await withProxy(allowAll, async (proxyPort) => {
    const start = Date.now();
    const codes = [];
    for (let i = 0; i < 4; i++)
      codes.push(await socksConnect(proxyPort, "127.0.0.1", port));
    const elapsed = Date.now() - start;
    assert.deepEqual(codes, [5, 5, 5, 5]);
    // Delays: 0 + 250 + 500 + 1000 ms; allow generous scheduling slack.
    assert.ok(elapsed >= 1500, `expected backoff, elapsed ${elapsed}ms`);
  });
});

test("first failure replies fast and distinct targets are independent", async () => {
  const portA = await refusedPort();
  const portB = await refusedPort();
  await withProxy(allowAll, async (proxyPort) => {
    // Prime target A with repeated failures.
    for (let i = 0; i < 3; i++)
      await socksConnect(proxyPort, "127.0.0.1", portA);
    // Target B's first failure must not inherit A's backoff.
    const start = Date.now();
    assert.equal(await socksConnect(proxyPort, "127.0.0.1", portB), 5);
    assert.ok(Date.now() - start < 200, "first failure should be instant");
  });
});

test("DNS failures back off too", async () => {
  await withProxy(allowAll, async (proxyPort) => {
    const host = "bw-guard-proxy-test.invalid";
    const start = Date.now();
    const codes = [];
    for (let i = 0; i < 3; i++)
      codes.push(await socksConnect(proxyPort, host, 443));
    const elapsed = Date.now() - start;
    assert.deepEqual(codes, [4, 4, 4]);
    // Delays: 0 + 250 + 500 ms.
    assert.ok(elapsed >= 600, `expected backoff, elapsed ${elapsed}ms`);
  });
});

test("policy denials stay instant", async () => {
  const deny = async () => ({ allowed: false, reason: "test" });
  await withProxy(deny, async (proxyPort) => {
    const start = Date.now();
    for (let i = 0; i < 5; i++)
      assert.equal(await socksConnect(proxyPort, "127.0.0.1", 9), 2);
    assert.ok(Date.now() - start < 500, "blocked replies must not back off");
  });
});

test("a successful connect clears the failure state", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  // Fail twice against the closed port, then reopen it and connect for real.
  await withProxy(allowAll, async (proxyPort) => {
    await socksConnect(proxyPort, "127.0.0.1", port);
    await socksConnect(proxyPort, "127.0.0.1", port);
    const revived = net.createServer((socket) => socket.end());
    await new Promise((resolve) => revived.listen(port, "127.0.0.1", resolve));
    try {
      assert.equal(await socksConnect(proxyPort, "127.0.0.1", port), 0);
      // Close it again: the next failure must be treated as a first failure.
      await new Promise((resolve) => revived.close(resolve));
      const start = Date.now();
      assert.equal(await socksConnect(proxyPort, "127.0.0.1", port), 5);
      assert.ok(Date.now() - start < 200, "failure state should have reset");
    } finally {
      await new Promise((resolve) => revived.close(() => resolve()));
    }
  });
});
