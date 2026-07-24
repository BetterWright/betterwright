import { describe, expect, it } from "vitest";
import { internalHeaders } from "../src/auth";
import { bytesToBase64Url, generateSessionId } from "../src/crypto";
import { RelaySession } from "../src/durable/relay-session";
import { makeBaseEnv, MemoryDurableState } from "./helpers";

function request(env: ReturnType<typeof makeBaseEnv>, path: string, body?: unknown, token = env.INTERNAL_DO_SECRET) {
  const headers = new Headers(internalHeaders(env));
  headers.set("X-Relay-Internal", token);
  return new Request(`https://internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sessionConfig() {
  return {
    sessionId: generateSessionId(),
    userId: "user_RelaySessionTest",
    createdAtMs: 1_000,
    expiresAtMs: 1_000_000,
    hostCapHash: bytesToBase64Url(new Uint8Array(32).fill(1)),
    viewerCapHash: bytesToBase64Url(new Uint8Array(32).fill(2)),
  };
}

describe("RelaySession Durable Object persistence", () => {
  it("initializes once with HMAC digests and no plaintext capability fields", async () => {
    const env = makeBaseEnv();
    const state = new MemoryDurableState();
    const relay = new RelaySession(state.asState(), env);
    const config = sessionConfig();
    const response = await relay.fetch(request(env, "/init", config));
    expect(response.status).toBe(200);
    expect((await response.json()) as any).toEqual({ ok: true, idempotent: false });
    expect(state.storageImpl.alarm).toBe(config.expiresAtMs);
    const stored = state.storageImpl.values.get("config") as Record<string, unknown>;
    expect(stored).toMatchObject(config);
    expect(Object.keys(stored).sort()).toEqual(
      ["createdAtMs", "expiresAtMs", "hostCapHash", "sessionId", "userId", "viewerCapHash"].sort(),
    );
  });

  it("makes identical initialization idempotent and rejects a conflicting reinitialization", async () => {
    const env = makeBaseEnv();
    const state = new MemoryDurableState();
    const relay = new RelaySession(state.asState(), env);
    const config = sessionConfig();
    await relay.fetch(request(env, "/init", config));
    expect((await (await relay.fetch(request(env, "/init", config))).json()) as any).toEqual({
      ok: true,
      idempotent: true,
    });
    const conflict = await relay.fetch(
      request(env, "/init", { ...config, viewerCapHash: bytesToBase64Url(new Uint8Array(32).fill(9)) }),
    );
    expect(conflict.status).toBe(409);
  });

  it("reports only connection lifecycle state, never hashes", async () => {
    const env = makeBaseEnv();
    const state = new MemoryDurableState();
    const relay = new RelaySession(state.asState(), env);
    await relay.fetch(request(env, "/init", sessionConfig()));
    const response = await relay.fetch(request(env, "/status"));
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      initialized: true,
      terminated: false,
      hostConnected: false,
      viewerConnected: false,
      leaseExpiresAtMs: null,
    });
    expect(text).not.toMatch(/CapHash|capability|root/i);
  });

  it("persists termination and makes it idempotent", async () => {
    const env = makeBaseEnv();
    const state = new MemoryDurableState();
    const relay = new RelaySession(state.asState(), env);
    await relay.fetch(request(env, "/init", sessionConfig()));
    const first = await relay.fetch(request(env, "/terminate", { reason: "deleted" }));
    expect((await first.json()) as any).toEqual({ ok: true, idempotent: false });
    expect(state.storageImpl.alarm).toBeNull();
    const second = await relay.fetch(request(env, "/terminate", { reason: "again" }));
    expect((await second.json()) as any).toEqual({ ok: true, idempotent: true });
  });

  it("denies all internal endpoints when the service token is wrong", async () => {
    const env = makeBaseEnv();
    const relay = new RelaySession(new MemoryDurableState().asState(), env);
    const response = await relay.fetch(request(env, "/status", undefined, "wrong-token"));
    expect(response.status).toBe(403);
    expect((await response.json()) as any).toMatchObject({ error: { code: "forbidden" } });
  });

  it("validates session IDs, users, timestamps, and hash lengths", async () => {
    const env = makeBaseEnv();
    const relay = new RelaySession(new MemoryDurableState().asState(), env);
    const good = sessionConfig();
    for (const bad of [
      { ...good, sessionId: "bad" },
      { ...good, userId: "not-a-clerk-user" },
      { ...good, expiresAtMs: good.createdAtMs },
      { ...good, hostCapHash: "short" },
    ]) {
      expect((await relay.fetch(request(env, "/init", bad))).status).toBe(400);
    }
  });
});
