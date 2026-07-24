import { describe, expect, it } from "vitest";
import { prepareRelaySession } from "../src/client/host-codec";
import { BudgetWindow, createWorkerHandler, RelaySession, UserQuota } from "../src/index";
import type { Env } from "../src/env";
import { DirectNamespace, FakeD1, makeBaseEnv, MemoryDurableState } from "./helpers";

function workerHarness() {
  const db = new FakeD1();
  let env = makeBaseEnv({
    DB: db.asDatabase(),
    ASSETS: { fetch: async () => new Response("static-asset", { status: 200 }) } as unknown as Fetcher,
  });
  const budgets = new DirectNamespace(() => new BudgetWindow(new MemoryDurableState().asState(), env));
  const quotas = new DirectNamespace(() => new UserQuota(new MemoryDurableState().asState(), env));
  const relays = new DirectNamespace(() => new RelaySession(new MemoryDurableState().asState(), env));
  env = {
    ...env,
    BUDGET_WINDOW: budgets.asNamespace(),
    USER_QUOTA: quotas.asNamespace(),
    RELAY_SESSION: relays.asNamespace(),
  };
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  } as unknown as ExecutionContext;
  const now = 1_000_000;
  const handler = createWorkerHandler({
    authenticateClerk: async () => ({ userId: "user_WorkerTest", sessionId: "sess_1" }),
    now: () => now,
  });
  const fetch = (request: Request) =>
    (handler.fetch as (request: Request, env: Env, context: ExecutionContext) => Promise<Response>)(
      request,
      env,
      context,
    );
  return { db, env, relays, quotas, budgets, pending, fetch, now };
}

function apiRequest(
  path: string,
  method = "GET",
  body?: unknown,
  headers: HeadersInit = {},
): Request {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  return new Request(`https://relay.example.com${path}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Worker routes", () => {
  it("reports readiness and persistent admission state through healthz", async () => {
    const h = workerHarness();
    const response = await h.fetch(apiRequest("/healthz"));
    expect(response.status).toBe(200);
    expect((await response.json()) as any).toEqual({ ok: true, admissionEnabled: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves the viewer only on the exact public origin and delegates static assets", async () => {
    const h = workerHarness();
    const id = `bws_${"A".repeat(24)}`;
    const viewer = await h.fetch(apiRequest(`/s/${id}`));
    expect(viewer.status).toBe(200);
    expect(await viewer.text()).toContain(`content="${id}"`);
    const wrongOrigin = await h.fetch(new Request(`https://other.example.com/s/${id}`));
    expect(wrongOrigin.status).toBe(404);
    expect(await (await h.fetch(apiRequest("/viewer.css"))).text()).toBe("static-asset");
  });

  it("creates and lists one-time API-key secrets under Clerk auth", async () => {
    const h = workerHarness();
    const origin = "https://app.example.com";
    const created = await h.fetch(
      apiRequest("/v1/keys", "POST", { name: "Laptop" }, { Origin: origin, Authorization: "Bearer clerk" }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const body = (await created.json()) as any;
    expect(body.oneTimeSecret).toBe(true);
    expect(body.secret).toMatch(/^bw_live_/);

    const listed = await h.fetch(apiRequest("/v1/keys", "GET", undefined, { Origin: origin }));
    const listBody = (await listed.json()) as any;
    expect(listBody.keys).toHaveLength(1);
    expect(listBody.keys[0]).toMatchObject({ id: body.key.id, name: "Laptop" });
    expect(JSON.stringify(listBody)).not.toContain(body.secret);

    const cliIdentity = await h.fetch(
      apiRequest("/v1/cli/me", "GET", undefined, {
        Authorization: `Bearer ${body.secret}`,
      }),
    );
    expect(cliIdentity.status).toBe(200);
    expect((await cliIdentity.json()) as any).toMatchObject({
      ok: true,
      id: "user_WorkerTest",
      apiKeyId: body.key.id,
      quota: { limitSeconds: 7_200, remainingSeconds: 7_200 },
      activeViewerLease: null,
    });
  });

  it("creates a session with one-time host/root material, then returns state without secrets", async () => {
    const h = workerHarness();
    const keyResponse = await h.fetch(apiRequest("/v1/keys", "POST", { name: "CLI" }));
    const apiKey = ((await keyResponse.json()) as any).secret as string;

    const prepared = await prepareRelaySession();
    const created = await h.fetch(
      apiRequest(
        "/v1/sessions",
        "POST",
        { sessionId: prepared.sessionId, viewerProof: prepared.viewerProof },
        { Authorization: `Bearer ${apiKey}` },
      ),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as any;
    expect(body.host.subprotocols).toHaveLength(2);
    expect(body.host).not.toHaveProperty("rootKey");
    expect(body.viewer.url).toBe(`https://relay.example.com/s/${body.session.id}`);
    expect(`${body.viewer.url}#k=${prepared.rootKey}`).toBe(
      `https://relay.example.com/s/${body.session.id}#k=${prepared.rootKey}`,
    );
    expect(body.host.websocketUrl).toBe(
      `wss://relay.example.com/v1/sessions/${body.session.id}/ws`,
    );
    const stored = h.db.sessions[0];
    expect(stored.host_cap_hash).toHaveLength(43);
    expect(stored.viewer_cap_hash).toHaveLength(43);
    expect(JSON.stringify(stored)).not.toContain(prepared.rootKey);
    expect(JSON.stringify(stored)).not.toContain(body.host.subprotocols[1]);

    const status = await h.fetch(
      apiRequest(`/v1/sessions/${body.session.id}`, "GET", undefined, {
        Authorization: `Bearer ${apiKey}`,
      }),
    );
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(JSON.parse(statusText)).toMatchObject({
      session: { id: body.session.id, status: "waiting" },
      relay: { hostConnected: false, viewerConnected: false },
    });
    expect(statusText).not.toContain(prepared.rootKey);
    expect(statusText).not.toContain(body.host.subprotocols[1]);
  });

  it("ends an owned session and purges D1 plus Durable Object state", async () => {
    const h = workerHarness();
    const keyResponse = await h.fetch(apiRequest("/v1/keys", "POST", { name: "CLI" }));
    const apiKey = ((await keyResponse.json()) as any).secret as string;
    const prepared = await prepareRelaySession();
    const sessionResponse = await h.fetch(
      apiRequest(
        "/v1/sessions",
        "POST",
        { sessionId: prepared.sessionId, viewerProof: prepared.viewerProof },
        { Authorization: `Bearer ${apiKey}` },
      ),
    );
    const sessionId = ((await sessionResponse.json()) as any).session.id as string;
    const deleted = await h.fetch(
      apiRequest(`/v1/sessions/${sessionId}`, "DELETE", undefined, {
        Authorization: `Bearer ${apiKey}`,
      }),
    );
    expect(deleted.status).toBe(204);
    expect(h.db.sessions).toHaveLength(0);
    const relay = h.relays.instances.get(`session:${sessionId}`) as RelaySession;
    const internalStatus = await relay.fetch(
      new Request("https://internal/status", {
        headers: { "X-Relay-Internal": h.env.INTERNAL_DO_SECRET },
      }),
    );
    expect((await internalStatus.json()) as any).toMatchObject({
      initialized: false,
      terminated: false,
    });
  });

  it("returns a zeroed Monday-UTC usage view for an account with no viewer", async () => {
    const h = workerHarness();
    const response = await h.fetch(apiRequest("/v1/me/usage"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.week.limitSeconds).toBe(7_200);
    expect(body.week.usedSeconds).toBe(0);
    expect(body.week.remainingSeconds).toBe(7_200);
    expect(body.activeViewerLease).toBeNull();
  });

  it("rejects suffix-origin attacks without reflecting them", async () => {
    const h = workerHarness();
    const attack = "https://app.example.com.attacker.test";
    const response = await h.fetch(apiRequest("/v1/me", "GET", undefined, { Origin: attack }));
    expect(response.status).toBe(403);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("authenticates the admin switch, disables admission, and cannot override an env switch", async () => {
    const h = workerHarness();
    expect((await h.fetch(apiRequest("/v1/admin/kill-switch"))).status).toBe(401);
    const enabled = await h.fetch(
      apiRequest(
        "/v1/admin/kill-switch",
        "PUT",
        { enabled: true, reason: "test stop" },
        { Authorization: `Bearer ${h.env.ADMIN_TOKEN}` },
      ),
    );
    expect(enabled.status).toBe(200);
    expect((await enabled.json()) as any).toMatchObject({ effectiveEnabled: true, reason: "test stop" });
    expect((await (await h.fetch(apiRequest("/healthz"))).json()) as any).toEqual({
      ok: true,
      admissionEnabled: false,
    });

    const keyResponse = await h.fetch(apiRequest("/v1/keys", "POST", { name: "CLI" }));
    const apiKey = ((await keyResponse.json()) as any).secret as string;
    const blocked = await h.fetch(
      apiRequest("/v1/sessions", "POST", {}, { Authorization: `Bearer ${apiKey}` }),
    );
    expect(blocked.status).toBe(503);
    expect((await blocked.json()) as any).toMatchObject({ error: { code: "relay_disabled" } });
  });

  it("returns a configuration-safe 503 without disclosing missing secret values", async () => {
    const h = workerHarness();
    h.env.PUBLIC_ORIGIN = "";
    const response = await h.fetch(apiRequest("/healthz"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      '{"error":{"code":"relay_not_configured","message":"Relay configuration is incomplete"}}',
    );
  });
});
