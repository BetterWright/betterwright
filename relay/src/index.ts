import { verifyWebhook } from "@clerk/backend/webhooks";
import { authenticateAdminRequest, authenticateClerkRequest, internalHeaders } from "./auth";
import {
  CLOSE_CODE,
  HOST_PROTOCOL_PREFIX,
  RELAY_PROTOCOL,
} from "./constants";
import { ConfigurationError, getConfig, requireSecret, type RelayConfig } from "./config";
import {
  base64UrlToBytes,
  generateCapability,
  hashCapability,
  isSessionId,
} from "./crypto";
import { BudgetWindow } from "./durable/budget-window";
import { RelaySession } from "./durable/relay-session";
import { UserQuota } from "./durable/user-quota";
import type { Env, ExecutionContextLike } from "./env";
import {
  applyCors,
  emptyResponse,
  enforceExactApiOrigin,
  errorResponse,
  HttpError,
  jsonResponse,
  normalizeThrownError,
  preflightResponse,
  readJsonObject,
} from "./http";
import { rejectedWebSocketResponse } from "./protocol";
import {
  authenticateApiKeyRequest,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "./repositories/api-keys";
import { getKillSwitch, setPersistentKillSwitch } from "./repositories/control";
import {
  countActiveSessions,
  endSession,
  findSessionForAdmission,
  findSessionForOwner,
  insertSession,
  listActiveSessionIds,
  listSessionIdsForUser,
  publicSession,
  removeSession,
  type SessionRow,
} from "./repositories/sessions";
import { billingWindow, toIso } from "./time";
import { viewerPageResponse } from "./viewer-page";

export { BudgetWindow, RelaySession, UserQuota };

interface HandlerDependencies {
  authenticateClerk: typeof authenticateClerkRequest;
  authenticateApiKey: typeof authenticateApiKeyRequest;
  now: () => number;
}

const defaultDependencies: HandlerDependencies = {
  authenticateClerk: authenticateClerkRequest,
  authenticateApiKey: authenticateApiKeyRequest,
  now: Date.now,
};

function methodNotAllowed(allowed: string[]): Response {
  const response = errorResponse(405, "method_not_allowed", "Method not allowed");
  const headers = new Headers(response.headers);
  headers.set("Allow", allowed.join(", "));
  return new Response(response.body, { status: response.status, headers });
}

function doStub(env: Env, namespace: DurableObjectNamespace, name: string): DurableObjectStub {
  return namespace.get(namespace.idFromName(name));
}

async function internalFetch(
  stub: DurableObjectStub,
  env: Env,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Response> {
  return stub.fetch(
    new Request(`https://internal${path}`, {
      method,
      headers: internalHeaders(env),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function assertAdmissionOpen(env: Env, config: RelayConfig): Promise<void> {
  let state;
  try {
    state = await getKillSwitch(env, config);
  } catch {
    throw new HttpError(503, "admission_unavailable", "Relay admission is temporarily unavailable");
  }
  if (state.effectiveEnabled) {
    throw new HttpError(503, "relay_disabled", "New relay connections are disabled");
  }
}

async function createSession(
  request: Request,
  env: Env,
  context: ExecutionContextLike,
  config: RelayConfig,
  dependencies: HandlerDependencies,
): Promise<Response> {
  const principal = await dependencies.authenticateApiKey(request, env, context);
  await assertAdmissionOpen(env, config);
  const body = await readJsonObject(request, 8_192);
  let ttlMs = config.sessionTtlMs;
  if (body.expiresInSeconds !== undefined) {
    if (!Number.isSafeInteger(body.expiresInSeconds)) {
      throw new HttpError(400, "invalid_expiry", "expiresInSeconds must be an integer");
    }
    ttlMs = (body.expiresInSeconds as number) * 1_000;
    if (ttlMs < config.leaseMs || ttlMs > config.sessionTtlMs) {
      throw new HttpError(400, "invalid_expiry", "Session expiry is outside the allowed range");
    }
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const viewerCapability = typeof body.viewerProof === "string" ? body.viewerProof : "";
  if (!isSessionId(sessionId)) {
    throw new HttpError(400, "invalid_session_id", "sessionId must be a client-generated BetterWright session ID");
  }
  try {
    base64UrlToBytes(viewerCapability, 32);
  } catch {
    throw new HttpError(400, "invalid_viewer_proof", "viewerProof must be a canonical 32-byte base64url proof");
  }

  const nowMs = dependencies.now();
  const hostCapability = generateCapability();
  const capabilitySecret = requireSecret(env, "CAPABILITY_HMAC_SECRET");
  const [hostCapHash, viewerCapHash] = await Promise.all([
    hashCapability(capabilitySecret, sessionId, "host", hostCapability),
    hashCapability(capabilitySecret, sessionId, "viewer", viewerCapability),
  ]);
  const row: SessionRow = {
    id: sessionId,
    user_id: principal.userId,
    api_key_id: principal.apiKeyId,
    host_cap_hash: hostCapHash,
    viewer_cap_hash: viewerCapHash,
    created_at_ms: nowMs,
    expires_at_ms: nowMs + ttlMs,
    ended_at_ms: null,
    ended_reason: null,
  };
  // Initialize the Durable Object first. Its absolute-expiry alarm bounds any
  // crash between the two persistence steps; inserting D1 first could leave a
  // row forever with no object or alarm to own cleanup.
  const stub = doStub(env, env.RELAY_SESSION, `session:${sessionId}`);
  let initialized: Response;
  try {
    initialized = await internalFetch(stub, env, "/init", "POST", {
      sessionId,
      userId: principal.userId,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      hostCapHash,
      viewerCapHash,
    });
  } catch {
    throw new HttpError(503, "session_unavailable", "The relay session could not be initialized");
  }
  if (!initialized.ok) {
    throw new HttpError(503, "session_unavailable", "The relay session could not be initialized");
  }

  try {
    await insertSession(env, row);
  } catch (error) {
    // The initialized object now owns a cleanup alarm. Ask it to purge early;
    // if this call or its D1 deletion fails, its tombstone alarm retries.
    await internalFetch(stub, env, "/terminate", "POST", {
      reason: "session metadata insertion failed",
    }).catch(() => null);
    const message = error instanceof Error ? error.message : "";
    if (/unique|primary key/i.test(message)) {
      throw new HttpError(409, "session_id_conflict", "Generate fresh client session material and retry");
    }
    throw error;
  }

  const websocketUrl = new URL(`/v1/sessions/${sessionId}/ws`, config.publicOrigin);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  const viewerUrl = new URL(`/s/${sessionId}`, config.publicOrigin);
  return jsonResponse(
    {
      session: {
        id: sessionId,
        createdAt: new Date(row.created_at_ms).toISOString(),
        expiresAt: new Date(row.expires_at_ms).toISOString(),
      },
      host: {
        websocketUrl: websocketUrl.toString(),
        subprotocols: [RELAY_PROTOCOL, `${HOST_PROTOCOL_PREFIX}${hostCapability}`],
      },
      viewer: {
        url: viewerUrl.toString(),
        fragmentParameter: "k",
      },
      oneTimeSecrets: { hostCapability: true },
    },
    201,
  );
}

async function sessionStatus(
  request: Request,
  env: Env,
  context: ExecutionContextLike,
  sessionId: string,
  dependencies: HandlerDependencies,
): Promise<Response> {
  const principal = await dependencies.authenticateApiKey(request, env, context);
  const row = await findSessionForOwner(env.DB, sessionId, principal.userId);
  if (!row) throw new HttpError(404, "session_not_found", "Session not found");
  const result = publicSession(row, dependencies.now());
  let relay = { hostConnected: false, viewerConnected: false, leaseExpiresAt: null as string | null };
  if (result.status !== "ended" && result.status !== "expired") {
    try {
      const response = await internalFetch(
        doStub(env, env.RELAY_SESSION, `session:${sessionId}`),
        env,
        "/status",
        "GET",
      );
      if (response.ok) {
        const state = (await response.json()) as {
          hostConnected?: boolean;
          viewerConnected?: boolean;
          leaseExpiresAtMs?: number | null;
        };
        relay = {
          hostConnected: state.hostConnected === true,
          viewerConnected: state.viewerConnected === true,
          leaseExpiresAt: toIso(state.leaseExpiresAtMs),
        };
        result.status = relay.viewerConnected ? "active" : "waiting";
      }
    } catch {
      // D1 remains authoritative for ownership and lifecycle if the DO is briefly unavailable.
    }
  }
  return jsonResponse({ session: result, relay });
}

async function deleteSession(
  request: Request,
  env: Env,
  context: ExecutionContextLike,
  sessionId: string,
  dependencies: HandlerDependencies,
): Promise<Response> {
  const principal = await dependencies.authenticateApiKey(request, env, context);
  const row = await findSessionForOwner(env.DB, sessionId, principal.userId);
  if (!row) throw new HttpError(404, "session_not_found", "Session not found");
  await endSession(env.DB, sessionId, principal.userId, "deleted", dependencies.now());
  const response = await internalFetch(
    doStub(env, env.RELAY_SESSION, `session:${sessionId}`),
    env,
    "/terminate",
    "POST",
    { reason: "session deleted" },
  );
  if (!response.ok) throw new HttpError(503, "session_close_pending", "Session was marked ended but peers may still be closing");
  // RelaySession normally removes its own row before acknowledging. This
  // idempotent fallback handles legacy/orphan rows whose object had no config.
  await removeSession(env.DB, sessionId, principal.userId);
  return emptyResponse();
}

async function websocketRoute(request: Request, env: Env, config: RelayConfig, sessionId: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (new URL(request.url).origin !== config.publicOrigin) {
    return rejectedWebSocketResponse(CLOSE_CODE.AUTH_FAILED, "origin denied");
  }
  let session;
  try {
    session = await findSessionForAdmission(env.DB, sessionId);
  } catch {
    return rejectedWebSocketResponse(CLOSE_CODE.INTERNAL_ERROR, "admission unavailable");
  }
  if (!session || session.ended_at_ms !== null) {
    return rejectedWebSocketResponse(CLOSE_CODE.SESSION_CLOSED, "session closed");
  }
  if (session.expires_at_ms <= Date.now()) {
    return rejectedWebSocketResponse(CLOSE_CODE.SESSION_EXPIRED, "session expired");
  }
  try {
    await assertAdmissionOpen(env, config);
  } catch {
    return rejectedWebSocketResponse(CLOSE_CODE.KILL_SWITCH, "relay disabled");
  }
  const headers = new Headers(request.headers);
  headers.set("X-Relay-Internal", requireSecret(env, "INTERNAL_DO_SECRET"));
  const forwarded = new Request("https://internal/ws", { method: "GET", headers });
  return doStub(env, env.RELAY_SESSION, `session:${sessionId}`).fetch(forwarded);
}

async function accountServiceState(
  env: Env,
  config: RelayConfig,
  nowMs: number,
): Promise<Record<string, unknown>> {
  const killSwitch = await getKillSwitch(env, config);
  const window = billingWindow(
    nowMs,
    config.billingPeriodStartDayUtc,
    config.billingWindowId,
  );
  let reservedMicroUsd: number | null = null;
  try {
    const response = await internalFetch(
      doStub(env, env.BUDGET_WINDOW, `billing:${window.key}`),
      env,
      "/status",
      "GET",
    );
    if (response.ok) {
      const body = (await response.json()) as { reservedMicroUsd?: number };
      if (Number.isSafeInteger(body.reservedMicroUsd)) {
        reservedMicroUsd = Number(body.reservedMicroUsd);
      }
    }
  } catch {
    reservedMicroUsd = null;
  }
  const budgetUnavailable = reservedMicroUsd === null;
  const globalCapReached =
    reservedMicroUsd !== null &&
    reservedMicroUsd + config.leaseReservationMicroUsd > config.budgetCeilingMicroUsd;
  const acceptingSessions =
    !killSwitch.effectiveEnabled && !budgetUnavailable && !globalCapReached;
  return {
    status: killSwitch.effectiveEnabled
      ? "disabled"
      : budgetUnavailable
        ? "unavailable"
        : globalCapReached
          ? "budget_exhausted"
          : "active",
    acceptingSessions,
    disabled: killSwitch.effectiveEnabled || budgetUnavailable,
    globalCapReached,
    reason: killSwitch.reason || (budgetUnavailable ? "Budget admission state is unavailable" : ""),
    budget: {
      windowKey: window.key,
      reservedEstimateUsd:
        reservedMicroUsd === null ? null : reservedMicroUsd / 1_000_000,
      admissionCeilingUsd: config.budgetCeilingMicroUsd / 1_000_000,
    },
  };
}

async function usageRoute(env: Env, userId: string): Promise<Response> {
  const response = await internalFetch(
    doStub(env, env.USER_QUOTA, `user:${userId}`),
    env,
    "/status",
    "GET",
  );
  if (!response.ok) throw new HttpError(503, "usage_unavailable", "Usage is temporarily unavailable");
  const value = (await response.json()) as {
    week: {
      key: string;
      startsAtMs: number;
      endsAtMs: number;
      usedMs: number;
      remainingMs: number;
      limitMs: number;
    };
    activeLease?: { sessionId: string; startedAtMs: number; expiresAtMs: number } | null;
  };
  return jsonResponse({
    week: {
      key: value.week.key,
      startsAt: toIso(value.week.startsAtMs),
      endsAt: toIso(value.week.endsAtMs),
      usedSeconds: Math.floor(value.week.usedMs / 1_000),
      remainingSeconds: Math.floor(value.week.remainingMs / 1_000),
      limitSeconds: Math.floor(value.week.limitMs / 1_000),
    },
    activeViewerLease: value.activeLease
      ? {
          sessionId: value.activeLease.sessionId,
          startedAt: toIso(value.activeLease.startedAtMs),
          expiresAt: toIso(value.activeLease.expiresAtMs),
        }
      : null,
  });
}

async function adminKillSwitch(request: Request, env: Env, config: RelayConfig): Promise<Response> {
  await authenticateAdminRequest(request, env);
  if (request.method === "GET") return jsonResponse(await getKillSwitch(env, config));
  if (request.method !== "PUT") return methodNotAllowed(["GET", "PUT"]);
  const body = await readJsonObject(request, 4_096);
  await setPersistentKillSwitch(env, body.enabled, body.reason);
  let signaledSessions = 0;
  let truncated = false;
  if (body.enabled === true) {
    const ids = await listActiveSessionIds(env.DB, Date.now(), 10_001);
    truncated = ids.length > 10_000;
    const selected = ids.slice(0, 10_000);
    for (let offset = 0; offset < selected.length; offset += 50) {
      const batch = selected.slice(offset, offset + 50);
      const results = await Promise.allSettled(
        batch.map((id) =>
          internalFetch(doStub(env, env.RELAY_SESSION, `session:${id}`), env, "/evict", "POST"),
        ),
      );
      signaledSessions += results.filter(
        (result) => result.status === "fulfilled" && result.value.ok,
      ).length;
    }
  }
  return jsonResponse({ ...(await getKillSwitch(env, config)), signaledSessions, truncated });
}

async function clerkWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  let event;
  try {
    event = await verifyWebhook(request, {
      signingSecret: requireSecret(env, "CLERK_WEBHOOK_SIGNING_SECRET"),
    });
  } catch {
    throw new HttpError(400, "invalid_webhook", "Clerk webhook verification failed");
  }
  if (event.type !== "user.deleted") return emptyResponse();
  const userId = event.data?.id;
  if (typeof userId !== "string" || !/^user_[A-Za-z0-9]+$/.test(userId)) {
    throw new HttpError(400, "invalid_webhook", "Clerk deletion event has no valid user ID");
  }

  const sessionIds = await listSessionIdsForUser(env.DB, userId);
  const terminations = await Promise.all(
    sessionIds.map((sessionId) =>
      internalFetch(
        doStub(env, env.RELAY_SESSION, `session:${sessionId}`),
        env,
        "/terminate",
        "POST",
        { reason: "account deleted" },
      ),
    ),
  );
  if (terminations.some((response) => !response.ok)) {
    throw new HttpError(503, "deletion_pending", "Relay sessions are still closing");
  }
  const quota = await internalFetch(
    doStub(env, env.USER_QUOTA, `user:${userId}`),
    env,
    "/delete",
    "POST",
  );
  if (!quota.ok) throw new HttpError(503, "deletion_pending", "Quota deletion is still pending");

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM api_keys WHERE user_id = ?1").bind(userId),
  ]);
  return emptyResponse();
}

async function routeApi(
  request: Request,
  env: Env,
  context: ExecutionContextLike,
  config: RelayConfig,
  dependencies: HandlerDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/webhooks/clerk") return clerkWebhook(request, env);
  enforceExactApiOrigin(request, config.appOrigin);
  if (request.method === "OPTIONS") return preflightResponse(request, config.appOrigin);

  if (url.pathname === "/v1/admin/kill-switch") return adminKillSwitch(request, env, config);

  // The CLI verifies a BetterWright API key without requiring a Clerk browser
  // session. Keep this separate from /v1/me so the two credential types cannot
  // be confused by clients or middleware.
  if (url.pathname === "/v1/cli/me") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const principal = await dependencies.authenticateApiKey(request, env, context);
    const usageResponse = await usageRoute(env, principal.userId);
    if (!usageResponse.ok) throw new HttpError(503, "usage_unavailable", "Usage is temporarily unavailable");
    const usage = (await usageResponse.json()) as {
      week?: Record<string, unknown>;
      activeViewerLease?: Record<string, unknown> | null;
    };
    return jsonResponse({
      ok: true,
      id: principal.userId,
      apiKeyId: principal.apiKeyId,
      quota: usage.week ?? null,
      activeViewerLease: usage.activeViewerLease ?? null,
    });
  }

  if (url.pathname === "/v1/me") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const principal = await dependencies.authenticateClerk(request, env, config);
    const nowMs = dependencies.now();
    const [keys, activeSessions, service] = await Promise.all([
      listApiKeys(env.DB, principal.userId),
      countActiveSessions(env.DB, principal.userId, nowMs),
      accountServiceState(env, config, nowMs),
    ]);
    return jsonResponse({
      id: principal.userId,
      activeApiKeys: keys.length,
      activeSessions,
      service,
    });
  }
  if (url.pathname === "/v1/me/usage") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    const principal = await dependencies.authenticateClerk(request, env, config);
    return usageRoute(env, principal.userId);
  }
  if (url.pathname === "/v1/keys") {
    const principal = await dependencies.authenticateClerk(request, env, config);
    if (request.method === "GET") return jsonResponse({ keys: await listApiKeys(env.DB, principal.userId) });
    if (request.method === "POST") {
      const body = await readJsonObject(request, 8_192);
      const created = await createApiKey(env, principal.userId, body.name ?? "CLI key", dependencies.now());
      return jsonResponse({ key: created.key, secret: created.secret, oneTimeSecret: true }, 201);
    }
    return methodNotAllowed(["GET", "POST"]);
  }
  const keyMatch = /^\/v1\/keys\/([^/]+)$/.exec(url.pathname);
  if (keyMatch) {
    if (request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
    const principal = await dependencies.authenticateClerk(request, env, config);
    const revoked = await revokeApiKey(env.DB, principal.userId, keyMatch[1], dependencies.now());
    if (!revoked) throw new HttpError(404, "key_not_found", "API key not found");
    return emptyResponse();
  }

  if (url.pathname === "/v1/sessions") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    return createSession(request, env, context, config, dependencies);
  }
  const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    if (!isSessionId(sessionId)) throw new HttpError(404, "session_not_found", "Session not found");
    if (request.method === "GET") return sessionStatus(request, env, context, sessionId, dependencies);
    if (request.method === "DELETE") return deleteSession(request, env, context, sessionId, dependencies);
    return methodNotAllowed(["GET", "DELETE"]);
  }
  throw new HttpError(404, "not_found", "Endpoint not found");
}

export function createWorkerHandler(overrides: Partial<HandlerDependencies> = {}): ExportedHandler<Env> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return {
    async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      let config: RelayConfig;
      try {
        config = getConfig(env);
      } catch (error) {
        const response = error instanceof ConfigurationError
          ? errorResponse(503, "relay_not_configured", "Relay configuration is incomplete")
          : normalizeThrownError(error);
        return response;
      }

      if (url.pathname === "/healthz") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        try {
          const killSwitch = await getKillSwitch(env, config);
          return jsonResponse({ ok: true, admissionEnabled: !killSwitch.effectiveEnabled });
        } catch {
          return errorResponse(503, "database_unavailable", "Relay database is unavailable");
        }
      }

      const webSocketMatch = /^\/v1\/sessions\/([^/]+)\/ws$/.exec(url.pathname);
      if (webSocketMatch) {
        const sessionId = webSocketMatch[1];
        if (!isSessionId(sessionId)) return rejectedWebSocketResponse(CLOSE_CODE.SESSION_CLOSED, "session closed");
        return websocketRoute(request, env, config, sessionId);
      }

      const viewerMatch = /^\/s\/([^/]+)$/.exec(url.pathname);
      if (viewerMatch) {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        if (url.origin !== config.publicOrigin) return errorResponse(404, "not_found", "Not found");
        const sessionId = viewerMatch[1];
        if (!isSessionId(sessionId)) return errorResponse(404, "not_found", "Not found");
        return viewerPageResponse(sessionId, config.publicOrigin);
      }

      if (url.pathname.startsWith("/v1/")) {
        try {
          const response = await routeApi(request, env, context, config, dependencies);
          return applyCors(response, request, config.appOrigin);
        } catch (error) {
          return applyCors(normalizeThrownError(error), request, config.appOrigin);
        }
      }

      return env.ASSETS.fetch(request);
    },
  };
}

export default createWorkerHandler();
