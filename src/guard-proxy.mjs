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
const FAMILY_UNREACHABLE_TTL_MS = 30_000;
const FAILURE_BACKOFF_BASE_MS = 25;
const FAILURE_BACKOFF_MAX_MS = 1_000;
const FAILURE_BACKOFF_RESET_MS = 30_000;
const FAILURE_COOLDOWN_MS = 1_000;
const MAX_FAILURE_TARGETS = 256;
const FAMILY_UNREACHABLE_CODES = new Set(["ENETUNREACH", "EAFNOSUPPORT"]);

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

function socksReplyCode(error) {
  if (error?.code === "BW_PROXY_BLOCKED") return 2;
  if (error?.code === "ENETUNREACH") return 3;
  if (["BW_PROXY_DNS", "EHOSTUNREACH"].includes(error?.code)) return 4;
  if (error?.code === "ECONNREFUSED") return 5;
  if (error?.code === "EAFNOSUPPORT") return 8;
  return 1;
}

function ipv6FromBytes(value) {
  const groups = [];
  for (let offset = 0; offset < 16; offset += 2)
    groups.push(value.readUInt16BE(offset).toString(16));
  return groups.join(":");
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function waitFor(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

export function createGuardProxy({ guardUrl, executeId, transport = {} }) {
  let guardProxyServer = null;
  let guardProxyPort = null;
  const guardProxySockets = new Set();
  const unavailableFamilies = new Map();
  const targetFailures = new Map();
  const pendingFailureDelays = new Set();
  let stateGeneration = 0;
  // Hooks make transport failures deterministic in tests without depending on
  // the host's IPv6 configuration. Production uses Node's DNS, TCP, and clock.
  const lookup =
    typeof transport.lookup === "function" ? transport.lookup : dns.lookup;
  const dial = typeof transport.connect === "function" ? transport.connect : null;
  const now = typeof transport.now === "function" ? transport.now : Date.now;
  const delay = typeof transport.delay === "function" ? transport.delay : waitFor;
  const familyUnreachableTtlMs = positiveInteger(
    transport.familyUnreachableTtlMs,
    FAMILY_UNREACHABLE_TTL_MS,
  );
  const failureBackoffBaseMs = positiveInteger(
    transport.failureBackoffBaseMs,
    FAILURE_BACKOFF_BASE_MS,
  );
  const failureBackoffMaxMs = Math.max(
    failureBackoffBaseMs,
    positiveInteger(transport.failureBackoffMaxMs, FAILURE_BACKOFF_MAX_MS),
  );
  const failureBackoffResetMs = positiveInteger(
    transport.failureBackoffResetMs,
    FAILURE_BACKOFF_RESET_MS,
  );
  const failureCooldownMs = positiveInteger(
    transport.failureCooldownMs,
    FAILURE_COOLDOWN_MS,
  );
  const maxFailureTargets = positiveInteger(
    transport.maxFailureTargets,
    MAX_FAILURE_TARGETS,
  );

  function targetKey(host, port) {
    const normalized = String(host).toLowerCase();
    return `${net.isIP(normalized) === 6 ? `[${normalized}]` : normalized}:${port}`;
  }

  function unavailableFamilyError(family) {
    const cached = unavailableFamilies.get(family);
    if (!cached) return null;
    if (cached.expiresAt <= now()) {
      unavailableFamilies.delete(family);
      return null;
    }
    const error = new Error("Browser transport address family is temporarily unreachable");
    error.code = cached.code;
    return error;
  }

  function rememberUnavailableFamily(family, error) {
    if (![4, 6].includes(family) || !FAMILY_UNREACHABLE_CODES.has(error?.code))
      return;
    unavailableFamilies.delete(family);
    unavailableFamilies.set(family, {
      code: error.code,
      expiresAt: now() + familyUnreachableTtlMs,
    });
  }

  function trimTargetFailures() {
    while (targetFailures.size > maxFailureTargets) {
      let candidate = null;
      for (const [key, state] of targetFailures) {
        candidate ??= key;
        if (!state.probing) {
          candidate = key;
          break;
        }
      }
      targetFailures.delete(candidate);
    }
  }

  function beginTargetAttempt(key, generation) {
    if (generation !== stateGeneration) return { stale: true };
    const state = targetFailures.get(key);
    if (!state) return { state: null };
    targetFailures.delete(key);
    targetFailures.set(key, state);
    if (state.retryAt > now() || state.probing) return { suppressed: true, state };
    state.probing = true;
    return { state };
  }

  function rememberTargetFailure(
    key,
    error,
    previous,
    generation,
    { probeCompleted = false } = {},
  ) {
    if (generation !== stateGeneration) return null;
    const timestamp = now();
    const current = targetFailures.get(key) || previous;
    const failures =
      current && timestamp - current.at < failureBackoffResetMs
        ? current.failures + 1
        : 1;
    const exponent = Math.min(failures - 1, 30);
    const delayMs = Math.min(
      failureBackoffMaxMs,
      failureBackoffBaseMs * 2 ** exponent,
    );
    targetFailures.delete(key);
    targetFailures.set(key, {
      at: timestamp,
      code: error?.code || "BW_PROXY_CONNECT",
      delayMs,
      failures,
      probing: probeCompleted ? false : Boolean(current?.probing),
      retryAt: timestamp + failureCooldownMs,
    });
    trimTargetFailures();
    return delayMs;
  }

  async function waitForFailureDelay(delayMs, generation) {
    if (!delayMs || generation !== stateGeneration) return;
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = resolve;
      pendingFailureDelays.add(resolve);
    });
    const scheduled = Promise.resolve()
      .then(() => delay(delayMs))
      .catch(() => {});
    try {
      await Promise.race([scheduled, cancelled]);
    } finally {
      pendingFailureDelays.delete(cancel);
    }
  }

  function cachedTargetError(state) {
    const error = new Error("Browser transport target is temporarily unavailable");
    error.code = state?.code || "BW_PROXY_CONNECT";
    return error;
  }

  async function rejectCachedTarget(state, generation) {
    await waitForFailureDelay(state.delayMs, generation);
    throw cachedTargetError(state);
  }

  async function rejectTargetFailure(
    key,
    error,
    previous,
    generation,
    options,
  ) {
    const delayMs = rememberTargetFailure(
      key,
      error,
      previous,
      generation,
      options,
    );
    await waitForFailureDelay(delayMs, generation);
    throw error;
  }

  async function guardTransportTarget(host, port, attribution) {
    const targetDecision = await guardUrl(
      transportUrl(host, port),
      { method: "CONNECT", resourceType: "transport" },
      attribution,
    );
    if (!targetDecision?.allowed)
      throw proxyBlockedError(targetDecision?.reason);
  }

  async function guardedTransportAddresses(host, port, attribution) {
    let addresses;
    const family = net.isIP(host);
    if (family) addresses = [{ address: host, family }];
    else {
      try {
        addresses = await lookup(host, { all: true, verbatim: false });
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

  function connectSocket(address, port) {
    if (dial)
      return Promise.resolve(
        dial({ host: address.address, port, family: address.family }),
      );
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

  async function connectAddress(address, port, generation) {
    if (generation !== stateGeneration) throw cachedTargetError();
    const suppressed = unavailableFamilyError(address.family);
    if (suppressed) throw suppressed;
    try {
      const socket = await connectSocket(address, port);
      if (generation !== stateGeneration) {
        socket.destroy();
        throw cachedTargetError();
      }
      unavailableFamilies.delete(address.family);
      return dial ? trackProxySocket(socket) : socket;
    } catch (error) {
      if (generation === stateGeneration)
        rememberUnavailableFamily(address.family, error);
      throw error;
    }
  }

  async function connectGuardedTarget(host, port) {
    const key = targetKey(host, port);
    const generation = stateGeneration;
    const attribution = executeId();
    try {
      await guardTransportTarget(host, port, attribution);
    } catch (error) {
      return rejectTargetFailure(
        key,
        error,
        targetFailures.get(key),
        generation,
      );
    }

    const attempt = beginTargetAttempt(key, generation);
    if (attempt.stale) throw cachedTargetError();
    if (attempt.suppressed)
      return rejectCachedTarget(attempt.state, generation);

    try {
      const addresses = await guardedTransportAddresses(host, port, attribution);
      let lastError = null;
      for (const address of addresses) {
        try {
          const socket = await connectAddress(address, port, generation);
          if (generation === stateGeneration) targetFailures.delete(key);
          return socket;
        } catch (error) {
          lastError = error;
        }
      }
      const error = new Error("Browser transport could not reach the target");
      error.code = lastError?.code || "BW_PROXY_CONNECT";
      throw error;
    } catch (error) {
      return rejectTargetFailure(key, error, attempt.state, generation, {
        probeCompleted: true,
      });
    }
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
            reject(socksReplyCode(error));
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
    stateGeneration += 1;
    unavailableFamilies.clear();
    targetFailures.clear();
    for (const cancel of pendingFailureDelays) cancel();
    pendingFailureDelays.clear();
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
