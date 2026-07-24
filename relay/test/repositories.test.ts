import { describe, expect, it } from "vitest";
import {
  authenticateApiKeyRequest,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKeyName,
} from "../src/repositories/api-keys";
import { getKillSwitch, setPersistentKillSwitch } from "../src/repositories/control";
import {
  countActiveSessions,
  endSession,
  findSessionForAdmission,
  findSessionForOwner,
  insertSession,
  listActiveSessionIds,
  publicSession,
} from "../src/repositories/sessions";
import { getConfig } from "../src/config";
import { generateSessionId } from "../src/crypto";
import { FakeD1, makeBaseEnv } from "./helpers";

const userId = "user_RepositoryTest";

describe("API-key repository", () => {
  it("creates a one-time secret while persisting only its HMAC digest", async () => {
    const db = new FakeD1();
    const env = makeBaseEnv({ DB: db.asDatabase() });
    const created = await createApiKey(env, userId, "Mac CLI", 1_000);
    expect(created.secret).toMatch(/^bw_live_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
    expect(created.key).toMatchObject({ name: "Mac CLI", createdAt: new Date(1_000).toISOString() });
    expect(db.apiKeys).toHaveLength(1);
    expect(db.apiKeys[0].key_hash).toHaveLength(43);
    expect(db.apiKeys[0].key_hash).not.toContain(created.secret);
    expect(JSON.stringify(db.apiKeys[0])).not.toContain(created.secret);
  });

  it("lists public metadata without hash or secret", async () => {
    const db = new FakeD1();
    const env = makeBaseEnv({ DB: db.asDatabase() });
    const first = await createApiKey(env, userId, "First", 1_000);
    await createApiKey(env, userId, "Second", 2_000);
    const listed = await listApiKeys(env.DB, userId);
    expect(listed.map((key) => key.name)).toEqual(["Second", "First"]);
    expect(listed[1].prefix).toBe(`bw_live_${first.key.id}_…`);
    expect(JSON.stringify(listed)).not.toContain("key_hash");
    expect(JSON.stringify(listed)).not.toContain(first.secret);
  });

  it("enforces five active keys and permits replacement after revocation", async () => {
    const db = new FakeD1();
    const env = makeBaseEnv({ DB: db.asDatabase() });
    const created = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(await createApiKey(env, userId, `Key ${index + 1}`, index));
    }
    await expect(createApiKey(env, userId, "Sixth", 6)).rejects.toMatchObject({
      status: 409,
      code: "key_limit_reached",
    });
    expect(await revokeApiKey(env.DB, userId, created[0].key.id, 10)).toBe(true);
    await expect(createApiKey(env, userId, "Replacement", 11)).resolves.toBeDefined();
    expect(await listApiKeys(env.DB, userId)).toHaveLength(5);
  });

  it("authenticates the complete API key in constant-shape HMAC form and updates last use", async () => {
    const db = new FakeD1();
    const env = makeBaseEnv({ DB: db.asDatabase() });
    const created = await createApiKey(env, userId, "CLI", 1_000);
    const request = new Request("https://relay.example.com/v1/sessions", {
      headers: { Authorization: `Bearer ${created.secret}` },
    });
    await expect(authenticateApiKeyRequest(request, env)).resolves.toEqual({
      userId,
      apiKeyId: created.key.id,
    });
    expect(db.apiKeys[0].last_used_at_ms).toBeTypeOf("number");
  });

  it("returns the same generic failure for malformed, wrong-secret, and revoked keys", async () => {
    const db = new FakeD1();
    const env = makeBaseEnv({ DB: db.asDatabase() });
    const created = await createApiKey(env, userId, "CLI", 1_000);
    const values = [
      "not-a-key",
      `${created.secret.slice(0, -1)}${created.secret.endsWith("A") ? "B" : "A"}`,
    ];
    for (const value of values) {
      await expect(
        authenticateApiKeyRequest(
          new Request("https://relay.example.com/v1/sessions", {
            headers: { Authorization: `Bearer ${value}` },
          }),
          env,
        ),
      ).rejects.toMatchObject({ status: 401, code: "invalid_api_key" });
    }
    await revokeApiKey(env.DB, userId, created.key.id);
    await expect(
      authenticateApiKeyRequest(
        new Request("https://relay.example.com/v1/sessions", {
          headers: { Authorization: `Bearer ${created.secret}` },
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 401, code: "invalid_api_key" });
  });

  it.each(["", " ", "x".repeat(81), "bad\nname", 123, null])("rejects unsafe key name %j", (name) => {
    expect(() => validateApiKeyName(name)).toThrow();
  });
});

describe("session repository", () => {
  it("stores only capability hashes and exposes owner-scoped lifecycle state", async () => {
    const db = new FakeD1();
    const env = makeBaseEnv({ DB: db.asDatabase() });
    const apiKey = await createApiKey(env, userId, "CLI", 1_000);
    const id = generateSessionId();
    await insertSession(env, {
      id,
      user_id: userId,
      api_key_id: apiKey.key.id,
      host_cap_hash: "h".repeat(43),
      viewer_cap_hash: "v".repeat(43),
      created_at_ms: 2_000,
      expires_at_ms: 100_000,
      ended_at_ms: null,
      ended_reason: null,
    });
    expect(await findSessionForOwner(env.DB, id, userId)).toMatchObject({ id, host_cap_hash: "h".repeat(43) });
    expect(await findSessionForOwner(env.DB, id, "user_Other")).toBeNull();
    expect(await findSessionForAdmission(env.DB, id)).toMatchObject({ id, user_id: userId });
    expect(await countActiveSessions(env.DB, userId, 50_000)).toBe(1);
    expect(await listActiveSessionIds(env.DB, 50_000)).toEqual([id]);
    expect(publicSession((await findSessionForOwner(env.DB, id, userId))!, 50_000).status).toBe("waiting");

    expect(await endSession(env.DB, id, userId, "deleted", 60_000)).toBe(true);
    expect(publicSession((await findSessionForOwner(env.DB, id, userId))!, 70_000)).toMatchObject({
      status: "ended",
      endedAt: new Date(60_000).toISOString(),
    });
  });

  it("marks a non-ended session expired from its absolute timestamp", () => {
    expect(
      publicSession(
        {
          id: generateSessionId(),
          user_id: userId,
          api_key_id: "key",
          host_cap_hash: "h",
          viewer_cap_hash: "v",
          created_at_ms: 0,
          expires_at_ms: 10,
          ended_at_ms: null,
          ended_reason: null,
        },
        10,
      ).status,
    ).toBe("expired");
  });
});

describe("persistent kill switch repository", () => {
  it("combines persistent and environment switches without allowing API override of env", async () => {
    const db = new FakeD1();
    const env = makeBaseEnv({ DB: db.asDatabase(), RELAY_KILL_SWITCH: "true" });
    await setPersistentKillSwitch(env, false, "operator reopen", 123);
    expect(await getKillSwitch(env, getConfig(env))).toEqual({
      persistentEnabled: false,
      environmentEnabled: true,
      effectiveEnabled: true,
      reason: "operator reopen",
      updatedAt: new Date(123).toISOString(),
    });
  });

  it("validates manual switch input and reason length", async () => {
    const env = makeBaseEnv();
    await expect(setPersistentKillSwitch(env, "true", "bad")).rejects.toMatchObject({ status: 400 });
    await expect(setPersistentKillSwitch(env, true, "x".repeat(201))).rejects.toMatchObject({ status: 400 });
  });
});
