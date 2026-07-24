// Default network policy for the BetterWright worker.
//
// Every request the worker makes is answered by `NetworkPolicy.check`; the
// conformance vectors in tests/fixtures/policy-vectors.json pin every
// decision. A lower layer does not depend on this policy: all traffic is forced
// through the worker's loopback SOCKS proxy so even localhost reaches this
// check.

import net from "node:net";

export const METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
]);

export const METADATA_ADDRESSES = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
]);

function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inCidr4(value, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv4FromMappedIpv6(host) {
  let bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  const dottedIndex = bare.lastIndexOf(":");
  const dottedTail = bare.slice(dottedIndex + 1);
  if (dottedTail.includes(".")) {
    const value = ipv4ToInt(dottedTail);
    if (value === null) return null;
    bare = `${bare.slice(0, dottedIndex)}:${(value >>> 16).toString(16)}:${(
      value & 0xffff
    ).toString(16)}`;
  }

  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1))
    return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return null;
  const values = groups.map((group) => Number.parseInt(group, 16));
  if (!values.slice(0, 5).every((value) => value === 0) || values[5] !== 0xffff)
    return null;
  return `${values[6] >>> 8}.${values[6] & 0xff}.${values[7] >>> 8}.${values[7] & 0xff}`;
}

function categorizeIpv4(host) {
  const value = ipv4ToInt(host);
  if (value === null) return "public";
  if (METADATA_ADDRESSES.has(host)) return "metadata";
  if (inCidr4(value, ipv4ToInt("127.0.0.0"), 8)) return "loopback";
  if (
    inCidr4(value, ipv4ToInt("10.0.0.0"), 8) ||
    inCidr4(value, ipv4ToInt("172.16.0.0"), 12) ||
    inCidr4(value, ipv4ToInt("192.168.0.0"), 16) ||
    inCidr4(value, ipv4ToInt("169.254.0.0"), 16) ||
    inCidr4(value, ipv4ToInt("100.64.0.0"), 10) ||
    inCidr4(value, ipv4ToInt("0.0.0.0"), 8) ||
    // Documentation, benchmarking, multicast, and reserved ranges are
    // classified as non-public, matching the conformance vectors.
    inCidr4(value, ipv4ToInt("192.0.2.0"), 24) ||
    inCidr4(value, ipv4ToInt("198.18.0.0"), 15) ||
    inCidr4(value, ipv4ToInt("198.51.100.0"), 24) ||
    inCidr4(value, ipv4ToInt("203.0.113.0"), 24) ||
    inCidr4(value, ipv4ToInt("224.0.0.0"), 4) ||
    inCidr4(value, ipv4ToInt("240.0.0.0"), 4)
  )
    return "private";
  return "public";
}

function categorizeIp(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  const family = net.isIP(bare);
  if (family === 4) return categorizeIpv4(bare);
  if (family === 6) {
    const mapped = ipv4FromMappedIpv6(bare);
    if (mapped) return categorizeIpv4(mapped);
    if (METADATA_ADDRESSES.has(bare) || bare.startsWith("fd00:ec2:"))
      return "metadata";
    if (bare === "::1") return "loopback";
    if (
      bare === "::" ||
      bare.startsWith("fe80:") ||
      bare.startsWith("fc") ||
      bare.startsWith("fd") ||
      // Multicast (ff00::/8) is non-public.
      bare.startsWith("ff")
    )
      return "private";
    return "public";
  }
  return null;
}

export class NetworkPolicy {
  constructor(options = {}) {
    // Private networks and loopback are reachable by default; agents commonly
    // drive local dev servers, routers, and intranet hosts. Pass
    // `allowPrivateNetwork: false` / `allowLoopback: false` for a hardened
    // deployment. The cloud-metadata floor below is NOT governed by these and
    // stays blocked regardless.
    this.allowPrivateNetwork = options.allowPrivateNetwork !== false;
    this.allowLoopback = options.allowLoopback !== false;
    this.allowHosts = options.allowHosts || [];
    this.blockHosts = options.blockHosts || [];
    this.custom = typeof options.custom === "function" ? options.custom : null;
  }

  hostMatches(entry, hostname, port) {
    entry = String(entry || "")
      .toLowerCase()
      .trim();
    if (!entry) return false;
    let entryHost = entry;
    let entryPort = null;
    if (entry.includes(":") && !entry.startsWith("[")) {
      const index = entry.lastIndexOf(":");
      const portText = entry.slice(index + 1);
      if (/^\d+$/.test(portText)) {
        entryHost = entry.slice(0, index);
        entryPort = Number(portText);
      }
    }
    if (entryPort !== null && port !== entryPort) return false;
    entryHost = entryHost.replace(/^\[|\]$/g, "");
    hostname = hostname.replace(/^\[|\]$/g, "");
    return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
  }

  isMetadata(hostname) {
    if (METADATA_HOSTNAMES.has(hostname)) return true;
    return categorizeIp(hostname) === "metadata";
  }

  check(url, details = {}) {
    url = String(url || "").trim();
    if (!url) return { allowed: false, reason: "empty URL" };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: "invalid URL" };
    }
    const scheme = parsed.protocol.replace(":", "").toLowerCase();
    if (scheme === "about" && url.toLowerCase() === "about:blank")
      return { allowed: true };
    if (scheme === "data" || scheme === "blob") return { allowed: true };
    if (!["http", "https", "ws", "wss"].includes(scheme)) {
      return { allowed: false, reason: `unsupported browser URL scheme: ${scheme}` };
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) return { allowed: false, reason: "URL has no hostname" };
    const port = parsed.port ? Number(parsed.port) : null;

    const decision = this.checkHost(hostname, port);
    if (this.custom) {
      const override = this.custom(url, { ...details });
      if (override != null) {
        if (override.allowed && this.isMetadata(hostname)) {
          return {
            allowed: false,
            reason: "cloud metadata endpoints cannot be allowed",
          };
        }
        return override;
      }
    }
    return decision;
  }

  checkHost(hostname, port) {
    if (this.isMetadata(hostname))
      return { allowed: false, reason: "cloud metadata endpoint" };

    for (const entry of this.blockHosts) {
      if (this.hostMatches(entry, hostname, port))
        return { allowed: false, reason: `host blocked by policy: ${entry}` };
    }
    for (const entry of this.allowHosts) {
      if (this.hostMatches(entry, hostname, port)) return { allowed: true };
    }

    const category = categorizeIp(hostname);
    if (category !== null) {
      if (category === "loopback" && !(this.allowLoopback || this.allowPrivateNetwork))
        return {
          allowed: false,
          reason: "loopback address (set allowLoopback for local dev)",
        };
      if (category === "private" && !this.allowPrivateNetwork)
        return { allowed: false, reason: "private or internal address" };
      return { allowed: true };
    }

    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      if (this.allowLoopback || this.allowPrivateNetwork) return { allowed: true };
      return {
        allowed: false,
        reason: "loopback address (set allowLoopback for local dev)",
      };
    }
    if (
      !hostname.includes(".") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".lan")
    ) {
      if (!this.allowPrivateNetwork)
        return { allowed: false, reason: "private or internal hostname" };
    }
    return { allowed: true };
  }
}
