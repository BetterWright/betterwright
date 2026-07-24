import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLOSE_CODE, HOST_PROTOCOL_PREFIX, RELAY_PROTOCOL, VIEWER_PROTOCOL_PREFIX } from "../src/constants";
import { generateCapability } from "../src/crypto";
import {
  applyCors,
  bearerCredential,
  cookieValue,
  enforceExactApiOrigin,
  HttpError,
  preflightResponse,
  readJsonObject,
} from "../src/http";
import { hostControlNotice, parseWebSocketProtocols } from "../src/protocol";
import { viewerPageResponse } from "../src/viewer-page";

const relayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("WebSocket subprotocol capabilities", () => {
  it("accepts exactly the version protocol followed by one canonical host capability", () => {
    const capability = generateCapability();
    expect(parseWebSocketProtocols(`${RELAY_PROTOCOL}, ${HOST_PROTOCOL_PREFIX}${capability}`)).toEqual({
      role: "host",
      capability,
    });
  });

  it("accepts a viewer proof with the same 32-byte canonical shape", () => {
    const proof = generateCapability();
    expect(parseWebSocketProtocols(`${RELAY_PROTOCOL},${VIEWER_PROTOCOL_PREFIX}${proof}`)).toEqual({
      role: "viewer",
      capability: proof,
    });
  });

  it.each([
    null,
    "",
    RELAY_PROTOCOL,
    `${RELAY_PROTOCOL}, bw.host.short`,
    `${RELAY_PROTOCOL}, bw.unknown.${"a".repeat(43)}`,
    `other.v1, bw.host.${"a".repeat(43)}`,
    `${RELAY_PROTOCOL}, bw.host.${"a".repeat(43)}, extra`,
    `bw.host.${"a".repeat(43)}, ${RELAY_PROTOCOL}`,
  ])("rejects ambiguous or malformed protocols %j", (header) => {
    expect(parseWebSocketProtocols(header)).toBeNull();
  });

  it("serializes only bounded relay lifecycle metadata for the host", () => {
    expect(hostControlNotice("viewer_connected", { leaseExpiresAtMs: 123 })).toBe(
      '{"t":"relay","event":"viewer_connected","leaseExpiresAtMs":123}',
    );
  });

  it("defines unique private close codes for every enforcement path", () => {
    const codes = Object.values(CLOSE_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => code >= 4000 && code <= 4999)).toBe(true);
  });
});

describe("exact-origin CORS and HTTP parsing", () => {
  const appOrigin = "https://app.example.com";

  it("adds credentials CORS only for the exact configured origin", async () => {
    const exact = new Request("https://relay.example.com/v1/me", { headers: { Origin: appOrigin } });
    const allowed = applyCors(new Response("ok"), exact, appOrigin);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(appOrigin);
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(await allowed.text()).toBe("ok");

    const suffixAttack = new Request("https://relay.example.com/v1/me", {
      headers: { Origin: "https://app.example.com.attacker.test" },
    });
    const denied = applyCors(new Response("ok"), suffixAttack, appOrigin);
    expect(denied.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(() => enforceExactApiOrigin(suffixAttack, appOrigin)).toThrow(HttpError);
  });

  it("returns a narrow preflight and rejects missing or unapproved browser origins", () => {
    const request = new Request("https://relay.example.com/v1/keys", {
      method: "OPTIONS",
      headers: {
        Origin: appOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    const response = preflightResponse(request, appOrigin);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(appOrigin);
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type");
    expect(() =>
      preflightResponse(new Request(request.url, { method: "OPTIONS" }), appOrigin),
    ).toThrow(/exact browser origin/);
  });

  it("extracts a single strict bearer credential and exact cookie name", () => {
    expect(bearerCredential(new Request("https://x", { headers: { Authorization: "Bearer token_1" } }))).toBe(
      "token_1",
    );
    expect(bearerCredential(new Request("https://x", { headers: { Authorization: "Bearer a b" } }))).toBeNull();
    expect(cookieValue(new Request("https://x", { headers: { Cookie: "other=1; __session=jwt.value; x=2" } }), "__session")).toBe(
      "jwt.value",
    );
  });

  it("accepts only bounded JSON objects", async () => {
    await expect(
      readJsonObject(
        new Request("https://x", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"ok":true}',
        }),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      readJsonObject(new Request("https://x", { method: "POST", body: "{}" })),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readJsonObject(
        new Request("https://x", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "[]",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("viewer shell security", () => {
  it("serves a no-store shell with strict CSP and no root material in HTML", async () => {
    const sessionId = "bws_ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, 28);
    const response = viewerPageResponse(sessionId, "https://relay.example.com");
    const html = await response.text();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self' wss://relay.example.com");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(html).toContain(`content="${sessionId}"`);
    expect(html).toContain('src="/viewer.js"');
    expect(html).not.toContain("#k=");
    expect(html).not.toMatch(/<script(?![^>]*src=)/);
  });

  it("ships a client with no WebRTC, storage persistence, eval, or payload logging", async () => {
    const [viewer, viewerCrypto, relaySession] = await Promise.all([
      readFile(`${relayRoot}/public/viewer.js`, "utf8"),
      readFile(`${relayRoot}/public/viewer-crypto.js`, "utf8"),
      readFile(`${relayRoot}/src/durable/relay-session.ts`, "utf8"),
    ]);
    const browserSource = `${viewer}\n${viewerCrypto}`;
    expect(browserSource).not.toMatch(/RTCPeerConnection|webkitRTCPeerConnection|mozRTCPeerConnection/);
    expect(browserSource).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(browserSource).not.toMatch(/\beval\s*\(|new Function/);
    expect(browserSource).not.toMatch(/console\.(?:log|debug|info|warn|error)/);
    expect(relaySession).not.toMatch(/console\.(?:log|debug|info|warn|error)/);
    expect(viewer).toContain("history.replaceState");
    expect(viewer).toContain("bw_e2e_ready");
    expect(viewer).toContain("createEnvelopeReceiver");
    expect(viewer).toContain("createEnvelopeSender");
  });
});
