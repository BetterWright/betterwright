import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createGuardProxy } from "../../dist/src/guard-proxy.js";
import { createGuardUrl } from "../../dist/src/guard-url.js";

const IPV6_ONE = "2001:db8:0:0:0:0:0:1";
const IPV6_TWO = "2001:db8:0:0:0:0:0:2";

function codedError(code) {
  const error: any = new Error(`test transport error: ${code}`);
  error.code = code;
  return error;
}

function requestBytes(host, port = 443) {
  let address;
  let addressType;
  const family = net.isIP(host);
  if (family === 4) {
    addressType = 1;
    address = Buffer.from(host.split(".").map(Number));
  } else if (family === 6) {
    addressType = 4;
    const groups = host.split(":");
    assert.equal(groups.length, 8, "test IPv6 literals must be fully expanded");
    address = Buffer.alloc(16);
    for (let index = 0; index < groups.length; index += 1)
      address.writeUInt16BE(Number.parseInt(groups[index], 16), index * 2);
  } else {
    const encoded = Buffer.from(host);
    assert.ok(encoded.length > 0 && encoded.length <= 255);
    addressType = 3;
    address = Buffer.concat([Buffer.from([encoded.length]), encoded]);
  }
  const encodedPort = Buffer.alloc(2);
  encodedPort.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5, 1, 0, addressType]), address, encodedPort]);
}

function readBytes(socket, minimum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => finish(new Error("timed out reading SOCKS reply")), 2_000);
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
      if (length >= minimum)
        finish(null, Buffer.concat(chunks, length).subarray(0, minimum));
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("SOCKS socket closed before its reply"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function socksConnect(proxyPort, host, port = 443) {
  const client = net.createConnection({ host: "127.0.0.1", port: proxyPort });
  try {
    await once(client, "connect");
    client.write(Buffer.from([5, 1, 0]));
    assert.deepEqual(await readBytes(client, 2), Buffer.from([5, 0]));
    client.write(requestBytes(host, port));
    const reply = await readBytes(client, 10);
    return reply[1];
  } finally {
    client.destroy();
  }
}

function readHttpHeader(socket) {
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const timer = setTimeout(() => finish(new Error("timed out reading HTTP proxy reply")), 2_000);
    const finish = (error, result = "") => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(result);
    };
    const onData = (chunk) => {
      value += chunk.toString("latin1");
      const end = value.indexOf("\r\n\r\n");
      if (end >= 0) finish(null, value.slice(0, end + 4));
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("HTTP proxy socket closed before its reply"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function httpConnect(proxyPort, authority) {
  const client = net.createConnection({ host: "127.0.0.1", port: proxyPort });
  try {
    await once(client, "connect");
    client.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
    return await readHttpHeader(client);
  } finally {
    client.destroy();
  }
}

function proxyOptions(
  transport: Record<string, any> = {},
  guardUrl: (url?: any, details?: any) => Promise<any> = async () => ({ allowed: true }),
) {
  return {
    guardUrl,
    executeId: () => "guard-proxy-test",
    transport,
  };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function timedDelay(delays, paddingMs = 25) {
  return (milliseconds) =>
    new Promise((resolve) => {
      delays.push(milliseconds);
      setTimeout(resolve, milliseconds + paddingMs);
    });
}

test("the guard listener accepts HTTP CONNECT without weakening target checks", async () => {
  const calls = [];
  const proxy = createGuardProxy(
    proxyOptions(
      {
        lookup: async () => [{ address: "192.0.2.1", family: 4 }],
        connect: async () => new PassThrough(),
      },
      async (url, details) => {
        calls.push({ url, details });
        return { allowed: true };
      },
    ),
  );
  try {
    const port = await proxy.ensure();
    assert.match(await httpConnect(port, "example.test:443"), /^HTTP\/1\.1 200 /);
    assert.deepEqual(
      calls.map(({ url }) => url),
      ["https://example.test:443/", "https://192.0.2.1:443/"],
    );
  } finally {
    await proxy.close();
  }
});

test("HTTP CONNECT returns 403 before dialing a policy-blocked host", async () => {
  let dialed = false;
  const proxy = createGuardProxy(
    proxyOptions(
      {
        lookup: async () => [{ address: "192.0.2.1", family: 4 }],
        connect: async () => {
          dialed = true;
          return new PassThrough();
        },
        delay: async () => {},
      },
      async (url) => ({
        allowed: !url.includes("blocked.test"),
        reason: "test policy",
      }),
    ),
  );
  try {
    const port = await proxy.ensure();
    assert.match(await httpConnect(port, "blocked.test:443"), /^HTTP\/1\.1 403 /);
    assert.equal(dialed, false);
  } finally {
    await proxy.close();
  }
});

test("plain HTTP proxy requests are full-URL guarded and rewritten for the origin", async () => {
  let received = "";
  const target = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      received = chunk.toString("latin1");
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
  });
  target.listen({ host: "127.0.0.1", port: 0 });
  await once(target, "listening");
  const targetPort = (target.address() as AddressInfo).port;
  const calls = [];
  const proxy = createGuardProxy(
    proxyOptions(
      {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      },
      async (url, details) => {
        calls.push({ url, details });
        return { allowed: true };
      },
    ),
  );
  const client = new net.Socket();
  try {
    const port = await proxy.ensure();
    client.connect({ host: "127.0.0.1", port });
    await once(client, "connect");
    const response = new Promise<string>((resolve, reject) => {
      let text = "";
      client.on("data", (chunk) => {
        text += chunk.toString("latin1");
      });
      client.once("end", () => resolve(text));
      client.once("error", reject);
    });
    client.write(
      `GET http://plain.test:${targetPort}/path?q=1 HTTP/1.1\r\n` +
        "Host: ignored.test\r\nProxy-Authorization: secret\r\n\r\n",
    );
    assert.match(await response, /^HTTP\/1\.1 200 OK/);
    assert.match(received, /^GET \/path\?q=1 HTTP\/1\.1\r\n/);
    assert.match(received, new RegExp(`Host: plain\\.test:${targetPort}`));
    assert.doesNotMatch(received, /Proxy-Authorization/i);
    assert.equal(calls[0].url, `http://plain.test:${targetPort}/path?q=1`);
    assert.equal(calls[0].details.resourceType, "http-proxy");
  } finally {
    client.destroy();
    await proxy.close();
    await new Promise((resolve) => target.close(resolve));
  }
});

test("family unreachability suppresses new dials without skipping guard checks", async () => {
  let dialCount = 0;
  const guardCalls = [];
  const proxy = createGuardProxy(
    proxyOptions(
      {
        connect: async () => {
          dialCount += 1;
          throw codedError("ENETUNREACH");
        },
        delay: async () => {},
        familyUnreachableTtlMs: 100,
      },
      async (url, details) => {
        guardCalls.push({ url, details });
        return { allowed: true };
      },
    ),
  );
  try {
    const port = await proxy.ensure();
    assert.equal(await socksConnect(port, IPV6_ONE), 3);
    assert.equal(await socksConnect(port, IPV6_TWO), 3);
    assert.equal(dialCount, 1);
    assert.equal(guardCalls.length, 4);
    assert.ok(guardCalls.every(({ details }) => details.method === "CONNECT"));
  } finally {
    await proxy.close();
  }
});

test("family suppression expires at its bounded TTL", async () => {
  let clock = 1_000;
  let dialCount = 0;
  const proxy = createGuardProxy(
    proxyOptions({
      connect: async () => {
        dialCount += 1;
        throw codedError("EAFNOSUPPORT");
      },
      delay: async () => {},
      now: () => clock,
      familyUnreachableTtlMs: 100,
      failureBackoffBaseMs: 5,
      failureCooldownMs: 5,
    }),
  );
  try {
    const port = await proxy.ensure();
    assert.equal(await socksConnect(port, IPV6_ONE), 8);
    clock += 5;
    assert.equal(await socksConnect(port, IPV6_ONE), 8);
    assert.equal(dialCount, 1);
    clock = 1_100;
    assert.equal(await socksConnect(port, IPV6_ONE), 8);
    assert.equal(dialCount, 2);
  } finally {
    await proxy.close();
  }
});

test("open target cooldown suppresses DNS and connect work", async (t) => {
  await t.test("DNS failure", async () => {
    let lookupCount = 0;
    let topLevelChecks = 0;
    const delays = [];
    const proxy = createGuardProxy(
      proxyOptions(
        {
          lookup: async () => {
            lookupCount += 1;
            throw codedError("ENOTFOUND");
          },
          delay: timedDelay(delays),
          failureBackoffBaseMs: 5,
          failureBackoffMaxMs: 20,
          failureCooldownMs: 250,
        },
        async (_url, details) => {
          if (details.resourceType === "transport") topLevelChecks += 1;
          return { allowed: true };
        },
      ),
    );
    try {
      const port = await proxy.ensure();
      assert.equal(await socksConnect(port, "missing.test"), 4);
      assert.equal(await socksConnect(port, "missing.test"), 4);
      assert.equal(lookupCount, 1);
      assert.equal(topLevelChecks, 2);
      assert.deepEqual(delays, [5, 5]);
    } finally {
      await proxy.close();
    }
  });

  await t.test("fast connection failure", async () => {
    let lookupCount = 0;
    let dialCount = 0;
    let topLevelChecks = 0;
    let addressChecks = 0;
    const delays = [];
    const proxy = createGuardProxy(
      proxyOptions(
        {
          lookup: async () => {
            lookupCount += 1;
            return [{ address: "192.0.2.20", family: 4 }];
          },
          connect: async () => {
            dialCount += 1;
            throw codedError("ECONNREFUSED");
          },
          delay: timedDelay(delays),
          failureBackoffBaseMs: 5,
          failureBackoffMaxMs: 20,
          failureCooldownMs: 250,
        },
        async (_url, details) => {
          if (details.resourceType === "transport") topLevelChecks += 1;
          else addressChecks += 1;
          return { allowed: true };
        },
      ),
    );
    try {
      const port = await proxy.ensure();
      assert.equal(await socksConnect(port, "refused.test"), 5);
      assert.equal(await socksConnect(port, "refused.test"), 5);
      assert.equal(lookupCount, 1);
      assert.equal(dialCount, 1);
      assert.equal(topLevelChecks, 2);
      assert.equal(addressChecks, 1);
      assert.deepEqual(delays, [5, 5]);
    } finally {
      await proxy.close();
    }
  });
});

test("guard failures use bounded exponential delay without bypassing policy", async () => {
  let guardCount = 0;
  let lookupCount = 0;
  let dialCount = 0;
  const delays = [];
  const proxy = createGuardProxy(
    proxyOptions(
      {
        lookup: async () => {
          lookupCount += 1;
          return [{ address: "192.0.2.21", family: 4 }];
        },
        connect: async () => {
          dialCount += 1;
          throw codedError("ECONNREFUSED");
        },
        delay: async (milliseconds) => delays.push(milliseconds),
        now: () => 1_000,
        failureBackoffBaseMs: 5,
        failureBackoffMaxMs: 20,
        failureCooldownMs: 250,
      },
      async () => {
        guardCount += 1;
        return { allowed: false, reason: "test policy" };
      },
    ),
  );
  try {
    const port = await proxy.ensure();
    for (let attempt = 0; attempt < 4; attempt += 1)
      assert.equal(await socksConnect(port, "blocked.test"), 2);
    assert.equal(guardCount, 4);
    assert.equal(lookupCount, 0);
    assert.equal(dialCount, 0);
    assert.deepEqual(delays, [5, 10, 20, 20]);
  } finally {
    await proxy.close();
  }
});

test("an expired cooldown admits only one half-open DNS probe", async () => {
  let clock = 1_000;
  let lookupCount = 0;
  let topLevelChecks = 0;
  let denyNextTarget = false;
  let rejectProbe;
  const proxy = createGuardProxy(
    proxyOptions(
      {
        lookup: async () => {
          lookupCount += 1;
          if (lookupCount === 1) throw codedError("ENOTFOUND");
          if (lookupCount === 2)
            return new Promise((_resolve, reject) => {
              rejectProbe = reject;
            });
          throw codedError("ENOTFOUND");
        },
        delay: async () => {},
        now: () => clock,
        failureBackoffBaseMs: 5,
        failureCooldownMs: 20,
      },
      async (_url, details) => {
        if (details.resourceType === "transport") {
          topLevelChecks += 1;
          if (denyNextTarget) {
            denyNextTarget = false;
            return { allowed: false, reason: "test policy" };
          }
        }
        return { allowed: true };
      },
    ),
  );
  try {
    const port = await proxy.ensure();
    assert.equal(await socksConnect(port, "probe.test"), 4);

    clock += 20;
    const probe = socksConnect(port, "probe.test");
    await waitUntil(() => typeof rejectProbe === "function");
    denyNextTarget = true;
    assert.equal(await socksConnect(port, "probe.test"), 2);

    clock += 20;
    assert.equal(await socksConnect(port, "probe.test"), 2);
    assert.equal(lookupCount, 2);
    assert.equal(topLevelChecks, 4);

    rejectProbe(codedError("ENOTFOUND"));
    assert.equal(await probe, 4);
    assert.equal(lookupCount, 2);
  } finally {
    rejectProbe?.(codedError("test cleanup"));
    await proxy.close();
  }
});

test("per-target backoff is asynchronous, exponential, and capped on suppressed dials", async () => {
  let clock = 1_000;
  let dialCount = 0;
  const pendingDelays = [];
  const proxy = createGuardProxy(
    proxyOptions({
      connect: async () => {
        dialCount += 1;
        throw codedError("EAFNOSUPPORT");
      },
      delay: (milliseconds) =>
        new Promise((resolve) => pendingDelays.push({ milliseconds, resolve })),
      now: () => clock,
      failureBackoffBaseMs: 5,
      failureBackoffMaxMs: 20,
      failureCooldownMs: 20,
      familyUnreachableTtlMs: 1_000,
    }),
  );
  try {
    const port = await proxy.ensure();
    for (const [timestamp, expectedDelay] of [
      [1_000, 5],
      [1_005, 5],
      [1_020, 10],
      [1_030, 10],
      [1_040, 20],
      [1_060, 20],
      [1_065, 20],
    ]) {
      clock = timestamp;
      let settled = false;
      const request = socksConnect(port, IPV6_ONE).then((reply) => {
        settled = true;
        return reply;
      });
      await waitUntil(() => pendingDelays.length > 0);
      const pending = pendingDelays.shift();
      assert.equal(pending.milliseconds, expectedDelay);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      pending.resolve();
      assert.equal(await request, 8);
    }
    assert.equal(dialCount, 1);
  } finally {
    for (const pending of pendingDelays) pending.resolve();
    await proxy.close();
  }
});

test("target failure history is bounded and cleared by close", async () => {
  let clock = 1_000;
  const delays = [];
  const proxy = createGuardProxy(
    proxyOptions({
      connect: async () => {
        throw codedError("ECONNREFUSED");
      },
      delay: async (milliseconds) => delays.push(milliseconds),
      now: () => clock,
      failureBackoffBaseMs: 5,
      failureBackoffMaxMs: 100,
      failureCooldownMs: 5,
      maxFailureTargets: 2,
    }),
  );
  try {
    let port = await proxy.ensure();
    for (const host of [
      "192.0.2.1",
      "192.0.2.2",
      "192.0.2.3",
    ])
      assert.equal(await socksConnect(port, host), 5);
    clock += 5;
    for (const host of ["192.0.2.2", "192.0.2.1"])
      assert.equal(await socksConnect(port, host), 5);
    assert.deepEqual(delays, [5, 5, 5, 10, 5]);

    await proxy.close();
    port = await proxy.ensure();
    assert.equal(await socksConnect(port, "192.0.2.2"), 5);
    assert.equal(delays.at(-1), 5);
  } finally {
    await proxy.close();
  }
});

test("a successful connection resets target failure backoff", async () => {
  let clock = 1_000;
  const delays = [];
  let attempt = 0;
  const proxy = createGuardProxy(
    proxyOptions({
      connect: async () => {
        attempt += 1;
        if (attempt === 2) return new PassThrough();
        throw codedError("ECONNREFUSED");
      },
      delay: async (milliseconds) => delays.push(milliseconds),
      now: () => clock,
      failureBackoffBaseMs: 5,
      failureBackoffMaxMs: 100,
      failureCooldownMs: 5,
    }),
  );
  try {
    const port = await proxy.ensure();
    assert.equal(await socksConnect(port, "192.0.2.9"), 5);
    clock += 5;
    assert.equal(await socksConnect(port, "192.0.2.9"), 0);
    assert.equal(await socksConnect(port, "192.0.2.9"), 5);
    assert.deepEqual(delays, [5, 5]);
  } finally {
    await proxy.close();
  }
});

test("close cancels delayed replies and resets target cooldown", async () => {
  const pendingDelays = [];
  const proxy = createGuardProxy(
    proxyOptions({
      connect: async () => {
        throw codedError("ECONNREFUSED");
      },
      delay: (milliseconds) =>
        new Promise((resolve) => pendingDelays.push({ milliseconds, resolve })),
      failureBackoffBaseMs: 5,
      failureBackoffMaxMs: 100,
    }),
  );
  try {
    let port = await proxy.ensure();
    const firstRequest: Promise<any> = socksConnect(port, "192.0.2.30").then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitUntil(() => pendingDelays.length === 1);
    assert.equal(pendingDelays[0].milliseconds, 5);

    await proxy.close();
    const firstOutcome = await firstRequest;
    assert.ok(firstOutcome.error instanceof Error);
    pendingDelays[0].resolve();

    port = await proxy.ensure();
    const secondRequest = socksConnect(port, "192.0.2.30");
    await waitUntil(() => pendingDelays.length === 2);
    assert.equal(pendingDelays[1].milliseconds, 5);
    pendingDelays[1].resolve();
    assert.equal(await secondRequest, 5);
  } finally {
    for (const pending of pendingDelays) pending.resolve();
    await proxy.close();
  }
});

test("the default transport still completes a SOCKS5 connection", async () => {
  const upstream = net.createServer();
  upstream.listen({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const accepted = once(upstream, "connection");
  const proxy = createGuardProxy(proxyOptions());
  try {
    const proxyPort = await proxy.ensure();
    const upstreamPort = (upstream.address() as AddressInfo).port;
    assert.equal(await socksConnect(proxyPort, "127.0.0.1", upstreamPort), 0);
    const [socket] = await accepted;
    socket.destroy();
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("SOCKS5 replies preserve policy, reachability, and address errors", async (t) => {
  const cases = [
    {
      name: "blocked by policy",
      expected: 2,
      guardUrl: async () => ({ allowed: false, reason: "test policy" }),
    },
    {
      name: "DNS failure",
      expected: 4,
      host: "missing.test",
      transport: { lookup: async () => { throw codedError("ENOTFOUND"); } },
    },
    { name: "network unreachable", expected: 3, errorCode: "ENETUNREACH" },
    { name: "host unreachable", expected: 4, errorCode: "EHOSTUNREACH" },
    { name: "connection refused", expected: 5, errorCode: "ECONNREFUSED" },
    { name: "address family unsupported", expected: 8, errorCode: "EAFNOSUPPORT" },
    { name: "general connect failure", expected: 1, errorCode: "BW_PROXY_CONNECT" },
    { name: "success", expected: 0, success: true },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const transport: Record<string, any> = {
        delay: async () => {},
        ...item.transport,
      };
      if (item.errorCode)
        transport.connect = async () => {
          throw codedError(item.errorCode);
        };
      if (item.success) transport.connect = async () => new PassThrough();
      const proxy = createGuardProxy(
        proxyOptions(transport, item.guardUrl || (async () => ({ allowed: true }))),
      );
      try {
        const port = await proxy.ensure();
        assert.equal(await socksConnect(port, item.host || "192.0.2.10"), item.expected);
      } finally {
        await proxy.close();
      }
    });
  }
});

// --- Guard decision cache, driven through the proxy -------------------------
//
// These run the worker's real guardUrl (src/guard-url.ts) in front of the
// proxy, so what is asserted is the shipped cache, not a stand-in: how many
// times the client is actually consulted, and that caching never lets a
// connection reach an address no live decision covered.

const ALLOW = { allowed: true, cacheable: true };

function cachedGuardProxy(
  transport,
  decide: (payload?: any) => any = () => ALLOW,
  cacheOptions = {},
) {
  const rpcs = [];
  const rpc = async (_method, payload) => {
    rpcs.push(payload);
    return decide(payload);
  };
  const proxy = createGuardProxy({
    guardUrl: createGuardUrl({ rpc, ...cacheOptions }),
    executeId: () => "guard-proxy-test",
    transport,
  });
  return { proxy, rpcs, urls: () => rpcs.map((payload) => payload.url) };
}

function addressTransport(resolve, extra: Record<string, any> = {}) {
  const dialed = [];
  return {
    dialed,
    transport: {
      lookup: async () => resolve(),
      connect: async ({ host }) => {
        dialed.push(host);
        return new PassThrough();
      },
      delay: async () => {},
      ...extra,
    },
  };
}

test("a first connection guards the host and every address, a second guards nothing", async () => {
  const { dialed, transport } = addressTransport(() => [
    { address: "192.0.2.1", family: 4 },
    { address: "192.0.2.2", family: 4 },
  ]);
  const { proxy, rpcs, urls } = cachedGuardProxy(transport);
  try {
    const port = await proxy.ensure();
    assert.equal(await socksConnect(port, "cached.test"), 0);
    assert.deepEqual(urls(), [
      "https://cached.test:443/",
      "https://192.0.2.1:443/",
      "https://192.0.2.2:443/",
    ]);
    assert.deepEqual(dialed, ["192.0.2.1"]);

    assert.equal(await socksConnect(port, "cached.test"), 0);
    assert.equal(rpcs.length, 3, "every decision must have been served from the cache");
    assert.deepEqual(dialed, ["192.0.2.1", "192.0.2.1"]);
  } finally {
    await proxy.close();
  }
});

test("decisions the client does not mark cacheable are re-asked every time", async () => {
  for (const decision of [{ allowed: true }, { allowed: true, cacheable: false }]) {
    const { transport } = addressTransport(() => [
      { address: "192.0.2.1", family: 4 },
      { address: "192.0.2.2", family: 4 },
    ]);
    const { proxy, rpcs } = cachedGuardProxy(transport, () => decision);
    try {
      const port = await proxy.ensure();
      assert.equal(await socksConnect(port, "uncached.test"), 0);
      assert.equal(rpcs.length, 3);
      assert.equal(await socksConnect(port, "uncached.test"), 0);
      assert.equal(
        rpcs.length,
        6,
        `${JSON.stringify(decision)} must reach the client on every connection`,
      );
    } finally {
      await proxy.close();
    }
  }
});

test("a rebound hostname is guarded again at its new address", async () => {
  let resolved = [{ address: "192.0.2.1", family: 4 }];
  const { dialed, transport } = addressTransport(() => resolved);
  const { proxy, urls } = cachedGuardProxy(transport);
  try {
    const port = await proxy.ensure();
    assert.equal(await socksConnect(port, "rebind.test"), 0);
    assert.deepEqual(urls(), ["https://rebind.test:443/", "https://192.0.2.1:443/"]);

    // The name is cached; the address it now resolves to is not, so the new
    // literal is decided before anything connects to it.
    resolved = [{ address: "198.51.100.7", family: 4 }];
    assert.equal(await socksConnect(port, "rebind.test"), 0);
    assert.deepEqual(urls(), [
      "https://rebind.test:443/",
      "https://192.0.2.1:443/",
      "https://198.51.100.7:443/",
    ]);
    assert.deepEqual(dialed, ["192.0.2.1", "198.51.100.7"]);
  } finally {
    await proxy.close();
  }
});

test("one blocked address blocks the connection, and the block is cached", async () => {
  let clock = 1_000;
  const { dialed, transport } = addressTransport(
    () => [
      { address: "192.0.2.1", family: 4 },
      { address: "192.0.2.66", family: 4 },
      { address: "192.0.2.3", family: 4 },
    ],
    { now: () => clock, failureCooldownMs: 1, failureBackoffBaseMs: 1 },
  );
  const { proxy, rpcs, urls } = cachedGuardProxy(transport, (payload) =>
    payload.url.includes("192.0.2.66")
      ? { allowed: false, reason: "test policy", cacheable: true }
      : ALLOW,
  );
  try {
    const port = await proxy.ensure();
    assert.equal(await socksConnect(port, "mixed.test"), 2);
    assert.deepEqual(
      urls(),
      [
        "https://mixed.test:443/",
        "https://192.0.2.1:443/",
        "https://192.0.2.66:443/",
        "https://192.0.2.3:443/",
      ],
      "validation stays exhaustive: every address is decided, even after a denial",
    );
    assert.deepEqual(dialed, [], "a denied address must stop the whole connection");

    clock += 5;
    assert.equal(await socksConnect(port, "mixed.test"), 2);
    assert.equal(rpcs.length, 4, "the denial must be cached like any other decision");
    assert.deepEqual(dialed, []);
  } finally {
    await proxy.close();
  }
});

test("a denial in address order wins over a rejection that settles first", async () => {
  // The addresses are guarded in parallel, so the error a caller sees must come
  // from address order rather than from whichever guard finished first.
  const settleOrder = [];
  const later = async (value) => {
    await new Promise((resolve) => setImmediate(resolve));
    settleOrder.push("first");
    return value;
  };
  const { transport } = addressTransport(
    () => [
      { address: "192.0.2.1", family: 4 },
      { address: "192.0.2.2", family: 4 },
    ],
    { failureBackoffBaseMs: 1 },
  );
  const { proxy } = cachedGuardProxy(transport, (payload) => {
    if (payload.url.includes("192.0.2.1"))
      return later({ allowed: false, reason: "test policy" });
    if (payload.url.includes("192.0.2.2")) {
      settleOrder.push("second");
      throw new Error("guard RPC failed");
    }
    return { allowed: true };
  });
  try {
    const port = await proxy.ensure();
    // 2 is "blocked by policy"; 1 would mean the RPC rejection won the race.
    assert.equal(await socksConnect(port, "ordered.test"), 2);
    assert.deepEqual(settleOrder, ["second", "first"]);
  } finally {
    await proxy.close();
  }
});

test("a failed guard RPC is never cached, so the next attempt asks again", async () => {
  let clock = 1_000;
  let failNext = true;
  const { dialed, transport } = addressTransport(() => [{ address: "192.0.2.1", family: 4 }], {
    now: () => clock,
    failureCooldownMs: 1,
    failureBackoffBaseMs: 1,
  });
  const { proxy, rpcs } = cachedGuardProxy(transport, (payload) => {
    if (payload.url.includes("192.0.2.1") && failNext) {
      failNext = false;
      throw new Error("guard RPC failed");
    }
    return ALLOW;
  });
  try {
    const port = await proxy.ensure();
    assert.equal(await socksConnect(port, "flaky.test"), 1);
    assert.equal(rpcs.length, 2);
    assert.deepEqual(dialed, []);

    clock += 5;
    assert.equal(await socksConnect(port, "flaky.test"), 0);
    assert.equal(rpcs.length, 3, "the address must be re-decided, not remembered as failed");
    assert.deepEqual(dialed, ["192.0.2.1"]);
  } finally {
    await proxy.close();
  }
});

test("an expired decision is re-asked before the next connection", async () => {
  let cacheClock = 0;
  const { transport } = addressTransport(() => [{ address: "192.0.2.1", family: 4 }]);
  const { proxy, rpcs } = cachedGuardProxy(transport, () => ALLOW, {
    now: () => cacheClock,
    ttlMs: 5_000,
  });
  try {
    const port = await proxy.ensure();
    assert.equal(await socksConnect(port, "ttl.test"), 0);
    assert.equal(rpcs.length, 2);
    cacheClock += 5_000;
    assert.equal(await socksConnect(port, "ttl.test"), 0);
    assert.equal(rpcs.length, 2);
    cacheClock += 1;
    assert.equal(await socksConnect(port, "ttl.test"), 0);
    assert.equal(rpcs.length, 4, "both the host and its address must be re-decided");
  } finally {
    await proxy.close();
  }
});
