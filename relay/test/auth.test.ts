import { describe, expect, it } from "vitest";
import {
  authenticateAdminRequest,
  authenticateClerkRequest,
  authenticateInternalRequest,
  clerkPrincipalFromVerification,
} from "../src/auth";
import { getConfig } from "../src/config";
import { makeBaseEnv } from "./helpers";

describe("Clerk verification result handling", () => {
  it("reads the current @clerk/backend {data, errors} return shape", () => {
    expect(
      clerkPrincipalFromVerification({
        data: { sub: "user_2RfWKJREkjKbHZy0Wqa5qrHeAnb", sid: "sess_123" },
      }),
    ).toEqual({ userId: "user_2RfWKJREkjKbHZy0Wqa5qrHeAnb", sessionId: "sess_123" });
  });

  it.each([
    null,
    {},
    { errors: [new Error("bad")] },
    { data: {} },
    { data: { sub: "not-a-clerk-user" } },
  ])("fails closed for malformed verification result %#", (result) => {
    expect(() => clerkPrincipalFromVerification(result)).toThrow();
  });

  it("requires a token and converts SDK verification errors to a generic 401", async () => {
    const env = makeBaseEnv();
    const config = getConfig(env);
    await expect(
      authenticateClerkRequest(new Request("https://relay.example.com/v1/me"), env, config),
    ).rejects.toMatchObject({ status: 401, code: "authentication_required" });
    await expect(
      authenticateClerkRequest(
        new Request("https://relay.example.com/v1/me", {
          headers: { Authorization: "Bearer not.a.jwt" },
        }),
        env,
        config,
      ),
    ).rejects.toMatchObject({ status: 401, code: "invalid_session" });
  });

  it("requires the exact app origin for cookie-authenticated mutations", async () => {
    const env = makeBaseEnv();
    const config = getConfig(env);
    await expect(
      authenticateClerkRequest(
        new Request("https://relay.example.com/v1/keys", {
          method: "POST",
          headers: { Cookie: "__session=not.a.jwt", Origin: "https://attacker.example" },
        }),
        env,
        config,
      ),
    ).rejects.toMatchObject({ status: 403, code: "origin_required" });
  });
});

describe("operator and internal bearer checks", () => {
  it("accepts only the exact admin bearer token", async () => {
    const env = makeBaseEnv();
    await expect(
      authenticateAdminRequest(
        new Request("https://relay.example.com/v1/admin/kill-switch", {
          headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
        }),
        env,
      ),
    ).resolves.toBeUndefined();
    await expect(
      authenticateAdminRequest(
        new Request("https://relay.example.com/v1/admin/kill-switch", {
          headers: { Authorization: "Bearer wrong" },
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("accepts only the exact service-to-Durable-Object token", async () => {
    const env = makeBaseEnv();
    await expect(
      authenticateInternalRequest(
        new Request("https://internal/status", {
          headers: { "X-Relay-Internal": env.INTERNAL_DO_SECRET },
        }),
        env,
      ),
    ).resolves.toBeUndefined();
    await expect(
      authenticateInternalRequest(
        new Request("https://internal/status", { headers: { "X-Relay-Internal": "wrong" } }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
