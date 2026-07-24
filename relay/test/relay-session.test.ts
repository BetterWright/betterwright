import { describe, expect, it } from "vitest";
import { internalHeaders } from "../src/auth";
import { bytesToBase64Url, generateSessionId } from "../src/crypto";
import { RelaySession } from "../src/durable/relay-session";
import { insertSession } from "../src/repositories/sessions";
import { FakeD1, makeBaseEnv, MemoryDurableState } from "./helpers";

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

  it("purges termination state and remains idempotent", async () => {
    const env = makeBaseEnv();
    const state = new MemoryDurableState();
    const relay = new RelaySession(state.asState(), env);
    await relay.fetch(request(env, "/init", sessionConfig()));
    const first = await relay.fetch(request(env, "/terminate", { reason: "deleted" }));
    expect((await first.json()) as any).toEqual({ ok: true, idempotent: false });
    expect(state.storageImpl.alarm).toBeNull();
    expect(state.storageImpl.values.size).toBe(0);
    const second = await relay.fetch(request(env, "/terminate", { reason: "again" }));
    expect((await second.json()) as any).toEqual({ ok: true, idempotent: true });
  });

  it("purges expired Durable Object and D1 session state", async () => {
    const db = new FakeD1();
    const env = makeBaseEnv({ DB: db.asDatabase() });
    const state = new MemoryDurableState();
    const relay = new RelaySession(state.asState(), env);
    const config = sessionConfig();
    await insertSession(env, {
      id: config.sessionId,
      user_id: config.userId,
      api_key_id: "key_test",
      host_cap_hash: config.hostCapHash,
      viewer_cap_hash: config.viewerCapHash,
      created_at_ms: config.createdAtMs,
      expires_at_ms: config.expiresAtMs,
      ended_at_ms: null,
      ended_reason: null,
    });
    await relay.fetch(request(env, "/init", config));

    await relay.alarm();

    expect(db.sessions).toHaveLength(0);
    expect(state.storageImpl.values.size).toBe(0);
    expect(state.storageImpl.alarm).toBeNull();
  });

  it("retains a tombstone alarm until transient D1 deletion succeeds", async () => {
    const db = new FakeD1();
    const env = makeBaseEnv({ DB: db.asDatabase() });
    const state = new MemoryDurableState();
    const relay = new RelaySession(state.asState(), env);
    const config = sessionConfig();
    await insertSession(env, {
      id: config.sessionId,
      user_id: config.userId,
      api_key_id: "key_test",
      host_cap_hash: config.hostCapHash,
      viewer_cap_hash: config.viewerCapHash,
      created_at_ms: config.createdAtMs,
      expires_at_ms: config.expiresAtMs,
      ended_at_ms: null,
      ended_reason: null,
    });
    await relay.fetch(request(env, "/init", config));
    db.sessionDeleteFailures = 1;

    const first = await relay.fetch(
      request(env, "/terminate", { reason: "deleted" }),
    );
    expect(first.status).toBe(500);
    expect(db.sessions).toHaveLength(1);
    expect(state.storageImpl.alarm).not.toBeNull();
    expect(state.storageImpl.values.get("config")).toMatchObject({
      sessionId: config.sessionId,
      terminatedAtMs: expect.any(Number),
    });

    await relay.alarm();
    expect(db.sessions).toHaveLength(0);
    expect(state.storageImpl.values.size).toBe(0);
    expect(state.storageImpl.alarm).toBeNull();
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
