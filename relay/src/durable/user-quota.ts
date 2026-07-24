import { authenticateInternalRequest, internalHeaders } from "../auth";
import { getConfig, type RelayConfig } from "../config";
import { isSessionId } from "../crypto";
import type { Env } from "../env";
import { HttpError, jsonResponse, normalizeThrownError, readJsonObject } from "../http";
import { SerialGate } from "../serial";
import { billingWindow, isoWeekWindow } from "../time";

export interface ActiveLease {
  leaseId: string;
  sessionId: string;
  userId: string;
  startedAtMs: number;
  expiresAtMs: number;
  status: "reserving" | "reserved" | "active";
  activationDeadlineMs: number;
  maxDurationMs: number;
  notAfterMs: number;
  budgetWindowKey: string;
  budgetWindowStartsAtMs: number;
  budgetWindowEndsAtMs: number;
}

interface QuotaLedger {
  weekKey: string;
  weekStartsAtMs: number;
  weekEndsAtMs: number;
  usedMs: number;
  active?: ActiveLease;
}

export function computeLeaseDurationMs(
  nowMs: number,
  usedMs: number,
  weeklyLimitMs: number,
  leaseLimitMs: number,
  weekEndsAtMs: number,
  billingWindowEndsAtMs: number,
  sessionExpiresAtMs: number,
): number {
  return Math.max(
    0,
    Math.floor(
      Math.min(
        leaseLimitMs,
        weeklyLimitMs - usedMs,
        weekEndsAtMs - nowMs,
        billingWindowEndsAtMs - nowMs,
        sessionExpiresAtMs - nowMs,
      ),
    ),
  );
}

export function chargedLeaseMs(lease: ActiveLease, endedAtMs: number): number {
  return Math.max(0, Math.min(endedAtMs, lease.expiresAtMs) - lease.startedAtMs);
}

function validUserId(value: unknown): value is string {
  return typeof value === "string" && /^user_[A-Za-z0-9]+$/.test(value);
}

export class UserQuota implements DurableObject {
  private readonly gate = new SerialGate();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      await authenticateInternalRequest(request, this.env);
      const path = new URL(request.url).pathname;
      if (path === "/acquire" && request.method === "POST") {
        return await this.gate.run(() => this.acquire(request));
      }
      if (path === "/activate" && request.method === "POST") {
        return await this.gate.run(() => this.activate(request));
      }
      if (path === "/release" && request.method === "POST") {
        return await this.gate.run(() => this.release(request));
      }
      if (path === "/status" && request.method === "GET") {
        return await this.gate.run(() => this.status());
      }
      if (path === "/delete" && request.method === "POST") {
        return await this.gate.run(async () => {
          await this.state.storage.deleteAll();
          return jsonResponse({ ok: true });
        });
      }
      throw new HttpError(404, "not_found", "Internal endpoint not found");
    } catch (error) {
      return normalizeThrownError(error);
    }
  }

  private freshLedger(nowMs: number): QuotaLedger {
    const week = isoWeekWindow(nowMs);
    return {
      weekKey: week.key,
      weekStartsAtMs: week.startsAtMs,
      weekEndsAtMs: week.endsAtMs,
      usedMs: 0,
    };
  }

  private async loadNormalized(nowMs: number): Promise<QuotaLedger> {
    let ledger = (await this.state.storage.get<QuotaLedger>("ledger")) ?? this.freshLedger(nowMs);
    let changed = false;
    if (
      ledger.active &&
      ledger.active.status !== "active" &&
      ledger.active.activationDeadlineMs <= nowMs
    ) {
      delete ledger.active;
      changed = true;
    } else if (ledger.active?.status === "active" && ledger.active.expiresAtMs <= nowMs) {
      ledger.usedMs += chargedLeaseMs(ledger.active, ledger.active.expiresAtMs);
      delete ledger.active;
      changed = true;
    }
    const week = isoWeekWindow(nowMs);
    if (ledger.weekKey !== week.key) {
      if (ledger.active) throw new Error("active quota lease crossed an ISO week boundary");
      ledger = this.freshLedger(nowMs);
      changed = true;
    }
    if (changed) await this.state.storage.put("ledger", ledger);
    return ledger;
  }

  private async reserveBudget(lease: ActiveLease, config: RelayConfig): Promise<"ok" | "exhausted" | "uncertain"> {
    const namespaceId = this.env.BUDGET_WINDOW.idFromName(`billing:${lease.budgetWindowKey}`);
    const stub = this.env.BUDGET_WINDOW.get(namespaceId);
    try {
      const response = await stub.fetch(
        new Request("https://internal/reserve", {
          method: "POST",
          headers: internalHeaders(this.env),
          body: JSON.stringify({
            reservationId: `${lease.userId}:${lease.leaseId}`,
            windowKey: lease.budgetWindowKey,
            startsAtMs: lease.budgetWindowStartsAtMs,
            endsAtMs: lease.budgetWindowEndsAtMs,
            amountMicroUsd: config.leaseReservationMicroUsd,
            ceilingMicroUsd: config.budgetCeilingMicroUsd,
          }),
        }),
      );
      const result = (await response.json()) as { ok?: boolean; code?: string };
      if (response.ok && result.ok === true) return "ok";
      if (response.status === 409 && result.code === "budget_exhausted") return "exhausted";
      return "uncertain";
    } catch {
      return "uncertain";
    }
  }

  private async acquire(request: Request): Promise<Response> {
    const config = getConfig(this.env);
    const body = await readJsonObject(request, 4_096);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const sessionExpiresAtMs = body.sessionExpiresAtMs;
    const userId = body.userId;
    if (!isSessionId(sessionId) || !validUserId(userId) || !Number.isSafeInteger(sessionExpiresAtMs)) {
      throw new HttpError(400, "invalid_internal_request", "Invalid quota lease request");
    }
    const nowMs = Date.now();
    let ledger = await this.loadNormalized(nowMs);

    if (ledger.active) {
      if (ledger.active.status === "reserving" && ledger.active.sessionId === sessionId && ledger.active.userId === userId) {
        const reservation = await this.reserveBudget(ledger.active, config);
        if (reservation === "ok") {
          ledger.active.status = "reserved";
          await this.state.storage.put("ledger", ledger);
          return jsonResponse({ ok: true, lease: ledger.active, resumed: true });
        }
        if (reservation === "exhausted") {
          delete ledger.active;
          await this.state.storage.put("ledger", ledger);
          return jsonResponse({ ok: false, code: "budget_exhausted" }, 409);
        }
        return jsonResponse({ ok: false, code: "budget_unavailable" }, 503);
      }
      if (ledger.active.status === "reserved" && ledger.active.sessionId === sessionId && ledger.active.userId === userId) {
        return jsonResponse({ ok: true, lease: ledger.active, resumed: true });
      }
      return jsonResponse(
        {
          ok: false,
          code: "active_viewer_lease",
          activeSessionId: ledger.active.sessionId,
          expiresAtMs: ledger.active.expiresAtMs,
        },
        409,
      );
    }

    const billing = billingWindow(nowMs, config.billingPeriodStartDayUtc, config.billingWindowId);
    const durationMs = computeLeaseDurationMs(
      nowMs,
      ledger.usedMs,
      config.weeklyViewerMs,
      config.leaseMs,
      ledger.weekEndsAtMs,
      billing.endsAtMs,
      sessionExpiresAtMs as number,
    );
    const maxDurationMs = Math.max(
      0,
      Math.min(config.leaseMs, config.weeklyViewerMs - ledger.usedMs),
    );
    const notAfterMs = Math.min(
      ledger.weekEndsAtMs,
      billing.endsAtMs,
      sessionExpiresAtMs as number,
    );
    if (durationMs < 1_000) {
      return jsonResponse(
        {
          ok: false,
          code: ledger.usedMs >= config.weeklyViewerMs ? "quota_exhausted" : "lease_unavailable",
          usedMs: ledger.usedMs,
          limitMs: config.weeklyViewerMs,
        },
        409,
      );
    }

    const lease: ActiveLease = {
      leaseId: crypto.randomUUID(),
      sessionId,
      userId,
      startedAtMs: nowMs,
      expiresAtMs: nowMs + durationMs,
      status: "reserving",
      activationDeadlineMs: Math.min(nowMs + 30_000, notAfterMs),
      maxDurationMs,
      notAfterMs,
      budgetWindowKey: billing.key,
      budgetWindowStartsAtMs: billing.startsAtMs,
      budgetWindowEndsAtMs: billing.endsAtMs,
    };
    ledger.active = lease;
    await this.state.storage.put("ledger", ledger);

    const reservation = await this.reserveBudget(lease, config);
    if (reservation === "ok") {
      lease.status = "reserved";
      ledger.active = lease;
      await this.state.storage.put("ledger", ledger);
      return jsonResponse({ ok: true, lease });
    }
    if (reservation === "exhausted") {
      delete ledger.active;
      await this.state.storage.put("ledger", ledger);
      return jsonResponse({ ok: false, code: "budget_exhausted" }, 409);
    }
    return jsonResponse({ ok: false, code: "budget_unavailable" }, 503);
  }

  private async activate(request: Request): Promise<Response> {
    const body = await readJsonObject(request, 4_096);
    const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!leaseId || !isSessionId(sessionId)) {
      throw new HttpError(400, "invalid_internal_request", "Invalid quota activation request");
    }
    const nowMs = Date.now();
    const ledger = await this.loadNormalized(nowMs);
    const lease = ledger.active;
    if (!lease || lease.leaseId !== leaseId || lease.sessionId !== sessionId) {
      return jsonResponse({ ok: false, code: "lease_unavailable" }, 409);
    }
    if (lease.status === "active") {
      return jsonResponse({ ok: true, lease, idempotent: true });
    }
    if (lease.status !== "reserved") {
      return jsonResponse({ ok: false, code: "lease_not_reserved" }, 409);
    }
    const durationMs = Math.max(0, Math.min(lease.maxDurationMs, lease.notAfterMs - nowMs));
    if (durationMs < 1_000) {
      delete ledger.active;
      await this.state.storage.put("ledger", ledger);
      return jsonResponse({ ok: false, code: "lease_unavailable" }, 409);
    }
    lease.startedAtMs = nowMs;
    lease.expiresAtMs = nowMs + durationMs;
    lease.status = "active";
    ledger.active = lease;
    await this.state.storage.put("ledger", ledger);
    return jsonResponse({ ok: true, lease, idempotent: false });
  }

  private async release(request: Request): Promise<Response> {
    const body = await readJsonObject(request, 4_096);
    const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const endedAtMs = body.endedAtMs;
    if (!leaseId || !isSessionId(sessionId) || !Number.isSafeInteger(endedAtMs)) {
      throw new HttpError(400, "invalid_internal_request", "Invalid quota release request");
    }
    const nowMs = Date.now();
    const ledger = await this.loadNormalized(nowMs);
    if (!ledger.active || ledger.active.leaseId !== leaseId || ledger.active.sessionId !== sessionId) {
      return jsonResponse({ ok: true, idempotent: true, usedMs: ledger.usedMs });
    }
    const lease = ledger.active;
    if (lease.status === "active") {
      const boundedEnd = Math.min(endedAtMs as number, nowMs + 5_000);
      ledger.usedMs += chargedLeaseMs(lease, boundedEnd);
    }
    delete ledger.active;
    await this.state.storage.put("ledger", ledger);
    return jsonResponse({ ok: true, idempotent: false, usedMs: ledger.usedMs });
  }

  private async status(): Promise<Response> {
    const config = getConfig(this.env);
    const nowMs = Date.now();
    const ledger = await this.loadNormalized(nowMs);
    const liveMs = ledger.active?.status === "active" ? chargedLeaseMs(ledger.active, nowMs) : 0;
    const usedMs = Math.min(config.weeklyViewerMs, ledger.usedMs + liveMs);
    return jsonResponse({
      ok: true,
      week: {
        key: ledger.weekKey,
        startsAtMs: ledger.weekStartsAtMs,
        endsAtMs: ledger.weekEndsAtMs,
        usedMs,
        remainingMs: Math.max(0, config.weeklyViewerMs - usedMs),
        limitMs: config.weeklyViewerMs,
      },
      activeLease: ledger.active?.status === "active" ? ledger.active : null,
    });
  }
}
