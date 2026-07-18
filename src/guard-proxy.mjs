// Local SOCKS5 proxy that funnels every browser transport connection through
// the worker's network guard. Chromium is pointed at this proxy on the command
// line, so even connections that bypass Playwright routing (service workers,
// WebRTC-adjacent fetches, HTTP/3 fallbacks) are policy-checked and connect
// only to pre-validated address literals — closing redirect-hop and
// DNS-rebinding gaps.
//
// This module is transport plumbing only: policy decisions stay in the worker,
// which supplies `guardUrl` and `executeId` for attribution.

import dns from "node:dns/promises";
import net from "node:net";

const SOCKS_HANDSHAKE_TIMEOUT_MS = 15_000;
const SOCKS_CONNECT_TIMEOUT_MS = 10_000;
const MAX_SOCKS_HANDSHAKE_BYTES = 8_192;

function transportUrl(host, port) {
  const scheme = port === 80 ? "http:" : "https:";
  const urlHost = net.isIP(host) === 6 ? `[${host}]` : host;
  return `${scheme}//${urlHost}:${port}/`;
}

function proxyBlockedError(reason = "Blocked by browser network policy") {
  const error = new Error(reason);
  error.code = "BW_PROXY_BLOCKED";
  return error;
}

function socksReply(code) {
  return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
}

function ipv6FromBytes(value) {
  const groups = [];
  for (let offset = 0; offset < 16; offset += 2)
    groups.push(value.readUInt16BE(offset).toString(16));
  return groups.join(":");
}

export function createGuardProxy({ guardUrl, executeId }) {
  let guardProxyServer = null;
  let guardProxyPort = null;
  const guardProxySockets = new Set();

  async function guardedTransportAddresses(host, port) {
    const attribution = executeId();
    const target = transportUrl(host, port);
    const targetDecision = await guardUrl(
      target,
      { method: "CONNECT", resourceType: "transport" },
      attribution,
    );
    if (!targetDecision?.allowed)
      throw proxyBlockedError(targetDecision?.reason);

    let addresses;
    const family = net.isIP(host);
    if (family) addresses = [{ address: host, family }];
    else {
      try {
        addresses = await dns.lookup(host, { all: true, verbatim: false });
      } catch {
        const error = new Error("Browser transport DNS resolution failed");
        error.code = "BW_PROXY_DNS";
        throw error;
      }
    }
    if (!addresses.length) {
      const error = new Error("Browser transport DNS returned no addresses");
      error.code = "BW_PROXY_DNS";
      throw error;
    }

    // Validate every answer, then connect to one of these exact literals. This
    // closes both redirect-hop and DNS-rebinding gaps: Chromium never performs a
    // second target lookup outside this guarded worker.
    for (const candidate of addresses) {
      const decision = await guardUrl(
        transportUrl(candidate.address, port),
        {
          method: "CONNECT",
          resourceType: "transport-address",
          resolvedFrom: host,
        },
        attribution,
      );
      if (!decision?.allowed) throw proxyBlockedError(decision?.reason);
    }
    return addresses;
  }

  function trackProxySocket(socket) {
    guardProxySockets.add(socket);
    socket.once("close", () => guardProxySockets.delete(socket));
    // A remote reset is normal browser-network behavior. Never let an unhandled
    // socket error terminate the long-lived worker.
    socket.on("error", () => socket.destroy());
    return socket;
  }

  function connectAddress(address, port) {
    return new Promise((resolve, reject) => {
      const socket = trackProxySocket(
        net.createConnection({
          host: address.address,
          port,
          family: address.family,
        }),
      );
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(SOCKS_CONNECT_TIMEOUT_MS, () => {
        const error = new Error("Browser transport connection timed out");
        error.code = "BW_PROXY_CONNECT";
        fail(error);
      });
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        socket.setTimeout(0);
        resolve(socket);
      });
    });
  }

  async function connectGuardedTarget(host, port) {
    const addresses = await guardedTransportAddresses(host, port);
    let lastError = null;
    for (const address of addresses) {
      try {
        return await connectAddress(address, port);
      } catch (error) {
        lastError = error;
      }
    }
    const error = new Error("Browser transport could not reach the target");
    error.code = lastError?.code || "BW_PROXY_CONNECT";
    throw error;
  }

  function handleGuardProxyClient(client) {
    trackProxySocket(client);
    client.setTimeout(SOCKS_HANDSHAKE_TIMEOUT_MS, () => client.destroy());
    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    let processing = false;

    const reject = (code) => {
      if (!client.destroyed) client.end(socksReply(code));
    };

    const processBuffer = async () => {
      if (processing || client.destroyed) return;
      processing = true;
      try {
        while (!client.destroyed) {
          if (stage === "greeting") {
            if (buffer.length < 2) return;
            const version = buffer[0];
            const methodCount = buffer[1];
            if (buffer.length < 2 + methodCount) return;
            const methods = buffer.subarray(2, 2 + methodCount);
            buffer = buffer.subarray(2 + methodCount);
            if (version === 5 && methods.includes(0) && client.writable) {
              client.write(Buffer.from([5, 0]));
            } else {
              client.end(Buffer.from([5, 255]));
              return;
            }
            stage = "request";
            continue;
          }

          if (buffer.length < 4) return;
          const version = buffer[0];
          const command = buffer[1];
          const reserved = buffer[2];
          const addressType = buffer[3];
          if (version !== 5 || reserved !== 0) {
            reject(1);
            return;
          }
          if (command !== 1) {
            reject(7);
            return;
          }

          let total;
          let host;
          if (addressType === 1) {
            total = 10;
            if (buffer.length < total) return;
            host = buffer.subarray(4, 8).join(".");
          } else if (addressType === 3) {
            if (buffer.length < 5) return;
            const length = buffer[4];
            total = 7 + length;
            if (!length || buffer.length < total) return;
            host = buffer.subarray(5, 5 + length).toString("utf8");
            if (host.includes("\ufffd") || /[\0\r\n]/.test(host)) {
              reject(8);
              return;
            }
          } else if (addressType === 4) {
            total = 22;
            if (buffer.length < total) return;
            host = ipv6FromBytes(buffer.subarray(4, 20));
          } else {
            reject(8);
            return;
          }

          const port = buffer.readUInt16BE(total - 2);
          if (!port) {
            reject(1);
            return;
          }
          const initialData = buffer.subarray(total);
          buffer = Buffer.alloc(0);
          client.pause();
          client.off("data", onData);
          try {
            const upstream = await connectGuardedTarget(host, port);
            if (client.destroyed) {
              upstream.destroy();
              return;
            }
            client.setTimeout(0);
            client.write(socksReply(0));
            if (initialData.length) upstream.write(initialData);
            client.pipe(upstream).pipe(client);
            client.resume();
          } catch (error) {
            reject(
              error?.code === "BW_PROXY_BLOCKED"
                ? 2
                : error?.code === "BW_PROXY_DNS"
                  ? 4
                  : 5,
            );
          }
          return;
        }
      } finally {
        processing = false;
      }
    };

    const onData = (chunk) => {
      if (buffer.length + chunk.length > MAX_SOCKS_HANDSHAKE_BYTES) {
        reject(1);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      void processBuffer();
    };
    client.on("data", onData);
  }

  async function ensure() {
    if (guardProxyServer && guardProxyPort) return guardProxyPort;
    const server = net.createServer(handleGuardProxyClient);
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", reject);
        resolve(server.address().port);
      });
    });
    guardProxyServer = server;
    guardProxyPort = port;
    server.on("error", () => {
      // Existing connections retain their own error handling. A future browser
      // call will restart the worker if the proxy actually becomes unavailable.
    });
    server.unref();
    return port;
  }

  async function close() {
    const server = guardProxyServer;
    guardProxyServer = null;
    guardProxyPort = null;
    for (const socket of guardProxySockets) socket.destroy();
    guardProxySockets.clear();
    if (!server) return;
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  return { ensure, close };
}
