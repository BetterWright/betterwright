import { authenticateInternalRequest, internalHeaders } from "../auth";
import { CLOSE_CODE } from "../constants";
import { getConfig, requireSecret, type RelayConfig } from "../config";
import { base64UrlToBytes, constantTimeEqual, hashCapability, isSessionId } from "../crypto";
import type { Env } from "../env";
import { HttpError, jsonResponse, normalizeThrownError, readJsonObject } from "../http";
import {
  acceptedWebSocketResponse,
  hostControlNotice,
  isWebSocketUpgrade,
  parseWebSocketProtocols,
  rejectedWebSocketResponse,
  type PeerRole,
} from "../protocol";
import { consumeRate, initialRateState, type RatePolicy, type RateState } from "../rate-limit";
import { getKillSwitch } from "../repositories/control";
import { SerialGate } from "../serial";
import type { ActiveLease } from "./user-quota";

interface StoredSessionConfig {
  sessionId: string;
  userId: string;
  createdAtMs: number;
  expiresAtMs: number;
  hostCapHash: string;
  viewerCapHash: string;
  terminatedAtMs?: number;
}

interface SocketAttachment {
  role: PeerRole;
  connectedAtMs: number;
  rate: RateState;
  lease?: ActiveLease;
  leaseReleased?: boolean;
  leaseWarningSent?: boolean;
}

interface QuotaAcquireResult {
  ok?: boolean;
  code?: string;
  lease?: ActiveLease;
}

function validUserId(value: unknown): value is string {
  return typeof value === "string" && /^user_[A-Za-z0-9]+$/.test(value);
}

function validHash(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    base64UrlToBytes(value, 32);
    return true;
  } catch {
    return false;
  }
}

export class RelaySession implements DurableObject {
  private readonly gate = new SerialGate();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      await authenticateInternalRequest(request, this.env);
      const path = new URL(request.url).pathname;
      if (path === "/init" && request.method === "POST") {
        return await this.gate.run(() => this.initialize(request));
      }
      if (path === "/ws" && request.method === "GET") {
        return await this.gate.run(() => this.upgrade(request));
      }
      if (path === "/status" && request.method === "GET") {
        return this.status();
      }
      if (path === "/terminate" && request.method === "POST") {
        return await this.gate.run(() => this.terminate(request));
      }
      if (path === "/evict" && request.method === "POST") {
        return await this.gate.run(() => this.evict());
      }
      throw new HttpError(404, "not_found", "Internal endpoint not found");
    } catch (error) {
      return normalizeThrownError(error);
    }
  }

  private async initialize(request: Request): Promise<Response> {
    const body = await readJsonObject(request, 8_192);
    const candidate: StoredSessionConfig = {
      sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
      userId: typeof body.userId === "string" ? body.userId : "",
      createdAtMs: Number(body.createdAtMs),
      expiresAtMs: Number(body.expiresAtMs),
      hostCapHash: typeof body.hostCapHash === "string" ? body.hostCapHash : "",
      viewerCapHash: typeof body.viewerCapHash === "string" ? body.viewerCapHash : "",
    };
    if (
      !isSessionId(candidate.sessionId) ||
      !validUserId(candidate.userId) ||
      !Number.isSafeInteger(candidate.createdAtMs) ||
      !Number.isSafeInteger(candidate.expiresAtMs) ||
      candidate.expiresAtMs <= candidate.createdAtMs ||
      !validHash(candidate.hostCapHash) ||
      !validHash(candidate.viewerCapHash)
    ) {
      throw new HttpError(400, "invalid_internal_request", "Invalid relay session initialization");
    }
    const existing = await this.state.storage.get<StoredSessionConfig>("config");
    if (existing) {
      const same =
        existing.sessionId === candidate.sessionId &&
        existing.userId === candidate.userId &&
        existing.createdAtMs === candidate.createdAtMs &&
        existing.expiresAtMs === candidate.expiresAtMs &&
        constantTimeEqual(existing.hostCapHash, candidate.hostCapHash) &&
        constantTimeEqual(existing.viewerCapHash, candidate.viewerCapHash);
      if (!same) throw new HttpError(409, "already_initialized", "Relay session is already initialized");
      return jsonResponse({ ok: true, idempotent: true });
    }
    await this.state.storage.put("config", candidate);
    await this.state.storage.setAlarm(candidate.expiresAtMs);
    return jsonResponse({ ok: true, idempotent: false });
  }

  private async upgrade(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      throw new HttpError(426, "upgrade_required", "A WebSocket upgrade is required");
    }
    const session = await this.state.storage.get<StoredSessionConfig>("config");
    if (!session || session.terminatedAtMs) {
      return rejectedWebSocketResponse(CLOSE_CODE.SESSION_CLOSED, "session closed");
    }
    const nowMs = Date.now();
    if (session.expiresAtMs <= nowMs) {
      return rejectedWebSocketResponse(CLOSE_CODE.SESSION_EXPIRED, "session expired");
    }
    const presented = parseWebSocketProtocols(request.headers.get("Sec-WebSocket-Protocol"));
    if (!presented) return rejectedWebSocketResponse(CLOSE_CODE.AUTH_FAILED, "authentication failed");

    const config = getConfig(this.env);
    const origin = request.headers.get("Origin");
    if (
      (presented.role === "viewer" && origin !== config.publicOrigin) ||
      (presented.role === "host" && origin !== null && origin !== config.publicOrigin)
    ) {
      return rejectedWebSocketResponse(CLOSE_CODE.AUTH_FAILED, "origin denied");
    }

    let killed = true;
    try {
      killed = (await getKillSwitch(this.env, config)).effectiveEnabled;
    } catch {
      killed = true;
    }
    if (killed) return rejectedWebSocketResponse(CLOSE_CODE.KILL_SWITCH, "relay disabled");

    const actualHash = await hashCapability(
      requireSecret(this.env, "CAPABILITY_HMAC_SECRET"),
      session.sessionId,
      presented.role,
      presented.capability,
    );
    const expectedHash = presented.role === "host" ? session.hostCapHash : session.viewerCapHash;
    if (!constantTimeEqual(actualHash, expectedHash)) {
      return rejectedWebSocketResponse(CLOSE_CODE.AUTH_FAILED, "authentication failed");
    }
    if (this.state.getWebSockets(presented.role).length > 0) {
      return rejectedWebSocketResponse(CLOSE_CODE.DUPLICATE_PEER, `${presented.role} already connected`);
    }
    if (presented.role === "viewer" && this.state.getWebSockets("host").length !== 1) {
      return rejectedWebSocketResponse(CLOSE_CODE.PEER_UNAVAILABLE, "host unavailable");
    }

    let lease: ActiveLease | undefined;
    if (presented.role === "viewer") {
      const admission = await this.acquireViewerLease(session);
      if (!admission.ok || !admission.lease) {
        if (admission.code === "quota_exhausted" || admission.code === "lease_unavailable") {
          this.notifyHost("quota_exhausted");
          return rejectedWebSocketResponse(CLOSE_CODE.QUOTA_EXHAUSTED, "viewer quota exhausted");
        }
        if (admission.code === "budget_exhausted") {
          this.notifyHost("budget_exhausted");
          return rejectedWebSocketResponse(CLOSE_CODE.BUDGET_EXHAUSTED, "relay budget exhausted");
        }
        if (admission.code === "active_viewer_lease") {
          return rejectedWebSocketResponse(CLOSE_CODE.DUPLICATE_PEER, "account viewer already active");
        }
        return rejectedWebSocketResponse(CLOSE_CODE.INTERNAL_ERROR, "admission unavailable");
      }
      lease = admission.lease;
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const policy = this.ratePolicy(config);
    const attachment: SocketAttachment = {
      role: presented.role,
      connectedAtMs: nowMs,
      rate: initialRateState(policy, nowMs),
      ...(lease ? { lease, leaseReleased: false, leaseWarningSent: false } : {}),
    };
    this.state.acceptWebSocket(server, [presented.role]);
    server.serializeAttachment(attachment);

    if (presented.role === "host") {
      this.sendHost(server, "host_ready", { sessionExpiresAtMs: session.expiresAtMs });
    } else if (lease) {
      const activation = await this.activateViewerLease(lease);
      if (!activation.ok || !activation.lease) {
        await this.releaseViewerLease(attachment, Date.now());
        server.serializeAttachment(attachment);
        server.close(CLOSE_CODE.INTERNAL_ERROR, "viewer lease activation failed");
        return acceptedWebSocketResponse(client);
      }
      lease = activation.lease;
      attachment.lease = lease;
      server.serializeAttachment(attachment);
      this.notifyHost("viewer_connected", { leaseExpiresAtMs: lease.expiresAtMs });
    }
    await this.scheduleAlarm(session);
    return acceptedWebSocketResponse(client);
  }

  private ratePolicy(config: RelayConfig): RatePolicy {
    return {
      sustainedMessagesPerSecond: config.sustainedMessagesPerSecond,
      burstMessages: config.burstMessages,
      maxBytesPerSecond: config.maxBytesPerSecond,
      byteBurstCapacity: Math.max(config.maxMessageBytes, config.maxBytesPerSecond),
    };
  }

  private async acquireViewerLease(session: StoredSessionConfig): Promise<QuotaAcquireResult> {
    const stub = this.env.USER_QUOTA.get(this.env.USER_QUOTA.idFromName(`user:${session.userId}`));
    try {
      const response = await stub.fetch(
        new Request("https://internal/acquire", {
          method: "POST",
          headers: internalHeaders(this.env),
          body: JSON.stringify({
            userId: session.userId,
            sessionId: session.sessionId,
            sessionExpiresAtMs: session.expiresAtMs,
          }),
        }),
      );
      return (await response.json()) as QuotaAcquireResult;
    } catch {
      return { ok: false, code: "admission_unavailable" };
    }
  }

  private async activateViewerLease(lease: ActiveLease): Promise<QuotaAcquireResult> {
    const stub = this.env.USER_QUOTA.get(this.env.USER_QUOTA.idFromName(`user:${lease.userId}`));
    try {
      const response = await stub.fetch(
        new Request("https://internal/activate", {
          method: "POST",
          headers: internalHeaders(this.env),
          body: JSON.stringify({ leaseId: lease.leaseId, sessionId: lease.sessionId }),
        }),
      );
      return (await response.json()) as QuotaAcquireResult;
    } catch {
      return { ok: false, code: "activation_unavailable" };
    }
  }

  private async releaseViewerLease(attachment: SocketAttachment, endedAtMs: number): Promise<void> {
    if (!attachment.lease || attachment.leaseReleased) return;
    attachment.leaseReleased = true;
    const lease = attachment.lease;
    const stub = this.env.USER_QUOTA.get(this.env.USER_QUOTA.idFromName(`user:${lease.userId}`));
    try {
      await stub.fetch(
        new Request("https://internal/release", {
          method: "POST",
          headers: internalHeaders(this.env),
          body: JSON.stringify({
            leaseId: lease.leaseId,
            sessionId: lease.sessionId,
            endedAtMs: Math.min(endedAtMs, lease.expiresAtMs),
          }),
        }),
      );
    } catch {
      // No payload is logged. UserQuota's lease expiry is the fail-safe settlement path.
    }
  }

  private attachment(webSocket: WebSocket): SocketAttachment | null {
    try {
      const value = webSocket.deserializeAttachment() as SocketAttachment | null;
      return value?.role === "host" || value?.role === "viewer" ? value : null;
    } catch {
      return null;
    }
  }

  private sendHost(
    webSocket: WebSocket,
    event: Parameters<typeof hostControlNotice>[0],
    fields: Record<string, string | number | boolean | null> = {},
  ): void {
    try {
      webSocket.send(hostControlNotice(event, fields));
    } catch {
      // Lifecycle notices are best effort and never contain relayed payloads.
    }
  }

  private notifyHost(
    event: Parameters<typeof hostControlNotice>[0],
    fields: Record<string, string | number | boolean | null> = {},
  ): void {
    for (const host of this.state.getWebSockets("host")) this.sendHost(host, event, fields);
  }

  async webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.attachment(webSocket);
    if (!attachment) {
      webSocket.close(CLOSE_CODE.INTERNAL_ERROR, "socket state unavailable");
      return;
    }
    if (typeof message === "string") {
      webSocket.close(CLOSE_CODE.BINARY_ONLY, "encrypted binary messages only");
      return;
    }
    const config = getConfig(this.env);
    if (message.byteLength > config.maxMessageBytes) {
      webSocket.close(CLOSE_CODE.MESSAGE_TOO_LARGE, "message too large");
      return;
    }
    const decision = consumeRate(attachment.rate, message.byteLength, Date.now(), this.ratePolicy(config));
    attachment.rate = decision.state;
    webSocket.serializeAttachment(attachment);
    if (!decision.allowed) {
      webSocket.close(CLOSE_CODE.RATE_LIMITED, "relay rate limit exceeded");
      return;
    }

    const targetRole: PeerRole = attachment.role === "host" ? "viewer" : "host";
    const target = this.state.getWebSockets(targetRole)[0];
    if (!target) {
      if (attachment.role === "viewer") webSocket.close(CLOSE_CODE.PEER_UNAVAILABLE, "host unavailable");
      return;
    }
    const bufferedAmount = Number(
      (target as WebSocket & { bufferedAmount?: number }).bufferedAmount ?? 0,
    );
    if (bufferedAmount > config.maxBufferedBytes) {
      target.close(CLOSE_CODE.BACKPRESSURE, "peer is too slow");
      return;
    }
    try {
      target.send(message);
    } catch {
      target.close(CLOSE_CODE.PEER_UNAVAILABLE, "peer unavailable");
    }
  }

  async webSocketClose(
    webSocket: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.gate.run(async () => {
      const attachment = this.attachment(webSocket);
      if (!attachment) return;
      const nowMs = Date.now();
      if (attachment.role === "viewer") {
        await this.releaseViewerLease(attachment, nowMs);
        this.notifyHost("viewer_disconnected", { code });
      } else {
        for (const viewer of this.state.getWebSockets("viewer")) {
          const viewerAttachment = this.attachment(viewer);
          if (viewerAttachment) await this.releaseViewerLease(viewerAttachment, nowMs);
          viewer.close(CLOSE_CODE.PEER_UNAVAILABLE, "host disconnected");
        }
      }
      const session = await this.state.storage.get<StoredSessionConfig>("config");
      if (session && !session.terminatedAtMs) await this.scheduleAlarm(session);
    });
  }

  async webSocketError(webSocket: WebSocket, _error: unknown): Promise<void> {
    const attachment = this.attachment(webSocket);
    if (attachment?.role === "viewer") await this.releaseViewerLease(attachment, Date.now());
    try {
      webSocket.close(CLOSE_CODE.INTERNAL_ERROR, "socket error");
    } catch {
      // The socket may already be gone.
    }
  }

  private async status(): Promise<Response> {
    const session = await this.state.storage.get<StoredSessionConfig>("config");
    const viewer = this.state.getWebSockets("viewer")[0];
    const viewerAttachment = viewer ? this.attachment(viewer) : null;
    return jsonResponse({
      ok: true,
      initialized: Boolean(session),
      terminated: Boolean(session?.terminatedAtMs),
      hostConnected: this.state.getWebSockets("host").length === 1,
      viewerConnected: Boolean(viewer),
      leaseExpiresAtMs: viewerAttachment?.lease?.expiresAtMs ?? null,
    });
  }

  private async purgeSessionState(
    session: StoredSessionConfig,
    retryAtMs = Date.now() + 60_000,
  ): Promise<void> {
    // Arm the retry before either deletion. If the process dies or deleteAll
    // fails after D1 is gone, the tombstone still has a near-term cleanup owner.
    await this.state.storage.setAlarm(retryAtMs);
    try {
      await this.env.DB
        .prepare("DELETE FROM sessions WHERE id = ?1 AND user_id = ?2")
        .bind(session.sessionId, session.userId)
        .run();
    } catch (error) {
      // Keep only the minimal config/tombstone and retry. Never delete the
      // object's last cleanup owner while its D1 row may still exist.
      throw error;
    }
    // Delete key/value state before the alarm. A crash between these awaits
    // leaves at most a one-shot empty-object alarm, never permanent config.
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
  }

  private async terminate(request: Request): Promise<Response> {
    const body = await readJsonObject(request, 2_048);
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 80) : "session closed";
    const session = await this.state.storage.get<StoredSessionConfig>("config");
    if (!session) return jsonResponse({ ok: true, idempotent: true });
    const idempotent = Boolean(session.terminatedAtMs);
    if (!session.terminatedAtMs) {
      session.terminatedAtMs = Date.now();
      await this.state.storage.put("config", session);
    }
    await this.closeAll(CLOSE_CODE.SESSION_CLOSED, reason, "session_closed");
    await this.purgeSessionState(session);
    return jsonResponse({ ok: true, idempotent });
  }

  private async evict(): Promise<Response> {
    await this.closeAll(CLOSE_CODE.KILL_SWITCH, "relay disabled", "kill_switch");
    const session = await this.state.storage.get<StoredSessionConfig>("config");
    if (session && !session.terminatedAtMs) await this.scheduleAlarm(session);
    return jsonResponse({ ok: true });
  }

  private async closeAll(
    closeCode: number,
    closeReason: string,
    hostEvent: Parameters<typeof hostControlNotice>[0],
  ): Promise<void> {
    const nowMs = Date.now();
    this.notifyHost(hostEvent);
    for (const viewer of this.state.getWebSockets("viewer")) {
      const attachment = this.attachment(viewer);
      if (attachment) {
        await this.releaseViewerLease(attachment, nowMs);
        try {
          viewer.serializeAttachment(attachment);
        } catch {
          // Closing socket may already be detached.
        }
      }
      viewer.close(closeCode, closeReason);
    }
    for (const host of this.state.getWebSockets("host")) host.close(closeCode, closeReason);
  }

  private async scheduleAlarm(session: StoredSessionConfig): Promise<void> {
    let next = session.expiresAtMs;
    const viewer = this.state.getWebSockets("viewer")[0];
    const attachment = viewer ? this.attachment(viewer) : null;
    if (attachment?.lease) {
      const warningAt = attachment.lease.expiresAtMs - 60_000;
      next = Math.min(next, attachment.leaseWarningSent ? attachment.lease.expiresAtMs : Math.max(Date.now() + 1, warningAt));
    }
    await this.state.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    await this.gate.run(async () => {
      const session = await this.state.storage.get<StoredSessionConfig>("config");
      if (!session) return;
      const nowMs = Date.now();
      if (session.terminatedAtMs) {
        await this.purgeSessionState(session, nowMs + 60_000);
        return;
      }
      if (nowMs >= session.expiresAtMs) {
        await this.closeAll(CLOSE_CODE.SESSION_EXPIRED, "session expired", "session_expired");
        await this.purgeSessionState(session, nowMs + 60_000);
        return;
      }
      const viewer = this.state.getWebSockets("viewer")[0];
      const attachment = viewer ? this.attachment(viewer) : null;
      if (viewer && attachment?.lease) {
        if (nowMs >= attachment.lease.expiresAtMs) {
          this.notifyHost("lease_expired", { leaseExpiresAtMs: attachment.lease.expiresAtMs });
          await this.releaseViewerLease(attachment, attachment.lease.expiresAtMs);
          viewer.serializeAttachment(attachment);
          viewer.close(CLOSE_CODE.LEASE_EXPIRED, "viewer lease expired; reconnect to renew");
          // The close callback will reschedule once the socket is detached.
          // Until then, avoid re-arming an alarm at the already-expired lease.
          await this.state.storage.setAlarm(session.expiresAtMs);
          return;
        }
        if (!attachment.leaseWarningSent && nowMs >= attachment.lease.expiresAtMs - 60_000) {
          attachment.leaseWarningSent = true;
          viewer.serializeAttachment(attachment);
          this.notifyHost("lease_expiring", { leaseExpiresAtMs: attachment.lease.expiresAtMs });
        }
      }
      await this.scheduleAlarm(session);
    });
  }
}
