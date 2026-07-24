import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internalHeaders } from "../src/auth";
import { BudgetWindow } from "../src/durable/budget-window";
import {
  chargedLeaseMs,
  computeLeaseDurationMs,
  UserQuota,
  type ActiveLease,
} from "../src/durable/user-quota";
import type { Env } from "../src/env";
import { DirectNamespace, makeBaseEnv, MemoryDurableState } from "./helpers";

const sessionA = `bws_${"A".repeat(24)}`;
const sessionB = `bws_${"B".repeat(24)}`;
const userId = "user_TestAccount1";
const monday = Date.parse("2026-07-20T00:00:00.000Z");

interface QuotaHarness {
  env: Env;
  quota: UserQuota;
  quotaState: MemoryDurableState;
  budgets: DirectNamespace;
}

function harness(overrides: Partial<Env> = {}): QuotaHarness {
  let env = makeBaseEnv(overrides);
  const budgets = new DirectNamespace(() => {
    const state = new MemoryDurableState();
    return new BudgetWindow(state.asState(), env);
  });
  env = { ...env, BUDGET_WINDOW: budgets.asNamespace() };
  const quotaState = new MemoryDurableState();
  const quota = new UserQuota(quotaState.asState(), env);
  return { env, quota, quotaState, budgets };
}

function quotaRequest(env: Env, path: string, body?: unknown): Request {
  return new Request(`https://internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: internalHeaders(env),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function reserveLease(h: QuotaHarness, sessionId = sessionA, expiresAtMs = monday + 24 * 60 * 60 * 1_000) {
  const response = await h.quota.fetch(
    quotaRequest(h.env, "/acquire", { userId, sessionId, sessionExpiresAtMs: expiresAtMs }),
  );
  return { response, body: (await response.json()) as any };
}

async function acquire(h: QuotaHarness, sessionId = sessionA, expiresAtMs = monday + 24 * 60 * 60 * 1_000) {
  const reserved = await reserveLease(h, sessionId, expiresAtMs);
  if (!reserved.body.ok) return reserved;
  const response = await h.quota.fetch(
    quotaRequest(h.env, "/activate", {
      leaseId: reserved.body.lease.leaseId,
      sessionId: reserved.body.lease.sessionId,
    }),
  );
  return { response, body: (await response.json()) as any };
}

async function release(h: QuotaHarness, lease: ActiveLease, endedAtMs: number) {
  const response = await h.quota.fetch(
    quotaRequest(h.env, "/release", {
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      endedAtMs,
    }),
  );
  return { response, body: (await response.json()) as any };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(monday);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pure lease accounting", () => {
  it("grants no more than 15 minutes or weekly remaining time", () => {
    expect(computeLeaseDurationMs(0, 0, 7_200_000, 900_000, 9_000_000, 9_000_000, 9_000_000)).toBe(
      900_000,
    );
    expect(
      computeLeaseDurationMs(0, 7_150_000, 7_200_000, 900_000, 9_000_000, 9_000_000, 9_000_000),
    ).toBe(50_000);
  });

  it("clamps a lease at ISO-week, billing-window, and session boundaries", () => {
    expect(computeLeaseDurationMs(1_000, 0, 7_200_000, 900_000, 61_000, 91_000, 121_000)).toBe(60_000);
    expect(computeLeaseDurationMs(1_000, 0, 7_200_000, 900_000, 900_000, 31_000, 121_000)).toBe(30_000);
    expect(computeLeaseDurationMs(1_000, 0, 7_200_000, 900_000, 900_000, 900_000, 21_000)).toBe(20_000);
  });

  it("charges only connected elapsed time and never beyond expiry", () => {
    const lease: ActiveLease = {
      leaseId: "lease",
      sessionId: sessionA,
      userId,
      startedAtMs: 1_000,
      expiresAtMs: 901_000,
      status: "active",
      activationDeadlineMs: 30_000,
      maxDurationMs: 900_000,
      notAfterMs: 901_000,
      budgetWindowKey: "window",
      budgetWindowStartsAtMs: 0,
      budgetWindowEndsAtMs: 1_000_000,
    };
    expect(chargedLeaseMs(lease, 1_000)).toBe(0);
    expect(chargedLeaseMs(lease, 121_000)).toBe(120_000);
    expect(chargedLeaseMs(lease, 9_000_000)).toBe(900_000);
    expect(chargedLeaseMs(lease, 0)).toBe(0);
  });
});

describe("UserQuota Durable Object", () => {
  it("issues one 15-minute active lease and reserves $0.0025", async () => {
    const h = harness();
    const result = await acquire(h);
    expect(result.response.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.lease.expiresAtMs - result.body.lease.startedAtMs).toBe(900_000);
    expect(result.body.lease.status).toBe("active");

    const budget = h.budgets.instances.values().next().value as BudgetWindow;
    const status = await budget.fetch(quotaRequest(h.env, "/status"));
    expect((await status.json()) as any).toMatchObject({ reservedMicroUsd: 2_500 });
  });

  it("does not charge the admission reservation before the viewer socket is activated", async () => {
    const h = harness();
    const reserved = await reserveLease(h);
    expect(reserved.body.lease.status).toBe("reserved");
    vi.setSystemTime(monday + 10_000);
    const beforeActivation = await h.quota.fetch(quotaRequest(h.env, "/status"));
    expect(((await beforeActivation.json()) as any).week.usedMs).toBe(0);

    const activated = await h.quota.fetch(
      quotaRequest(h.env, "/activate", {
        leaseId: reserved.body.lease.leaseId,
        sessionId: sessionA,
      }),
    );
    const active = (await activated.json()) as any;
    expect(active.lease.startedAtMs).toBe(monday + 10_000);
    expect(active.lease.expiresAtMs - active.lease.startedAtMs).toBe(900_000);
    vi.setSystemTime(monday + 15_000);
    const afterActivation = await h.quota.fetch(quotaRequest(h.env, "/status"));
    expect(((await afterActivation.json()) as any).week.usedMs).toBe(5_000);
  });

  it("rejects a second session while the account has an active viewer lease", async () => {
    const h = harness();
    const first = await acquire(h);
    const second = await acquire(h, sessionB);
    expect(first.body.ok).toBe(true);
    expect(second.response.status).toBe(409);
    expect(second.body).toMatchObject({ ok: false, code: "active_viewer_lease", activeSessionId: sessionA });
  });

  it("settles an early disconnect at exact connected time, not the reserved 15 minutes", async () => {
    const h = harness();
    const first = await acquire(h);
    const lease = first.body.lease as ActiveLease;
    vi.setSystemTime(monday + 123_456);
    const ended = await release(h, lease, monday + 123_456);
    expect(ended.body.usedMs).toBe(123_456);
    const status = await h.quota.fetch(quotaRequest(h.env, "/status"));
    const usage = (await status.json()) as any;
    expect(usage.week.usedMs).toBe(123_456);
    expect(usage.activeLease).toBeNull();
  });

  it("is idempotent when a release is retried", async () => {
    const h = harness();
    const first = await acquire(h);
    const lease = first.body.lease as ActiveLease;
    vi.setSystemTime(monday + 60_000);
    expect((await release(h, lease, monday + 60_000)).body.idempotent).toBe(false);
    const retry = await release(h, lease, monday + 60_000);
    expect(retry.body).toMatchObject({ ok: true, idempotent: true, usedMs: 60_000 });
  });

  it("enforces exactly two connected hours in an ISO week", async () => {
    const h = harness();
    for (let index = 0; index < 8; index += 1) {
      vi.setSystemTime(monday + index * 900_000);
      const result = await acquire(h);
      expect(result.body.ok).toBe(true);
      const lease = result.body.lease as ActiveLease;
      vi.setSystemTime(lease.expiresAtMs);
      await release(h, lease, lease.expiresAtMs);
    }
    vi.setSystemTime(monday + 7_200_000);
    const ninth = await acquire(h);
    expect(ninth.response.status).toBe(409);
    expect(ninth.body).toMatchObject({ ok: false, code: "quota_exhausted", usedMs: 7_200_000 });
  });

  it("starts a fresh allowance on the next Monday UTC", async () => {
    const h = harness({ WEEKLY_VIEWER_SECONDS: "60", LEASE_SECONDS: "60" });
    const first = await acquire(h, sessionA, monday + 8 * 24 * 60 * 60 * 1_000);
    const lease = first.body.lease as ActiveLease;
    vi.setSystemTime(lease.expiresAtMs);
    await release(h, lease, lease.expiresAtMs);
    expect((await acquire(h)).body.code).toBe("quota_exhausted");
    const nextMonday = monday + 7 * 24 * 60 * 60 * 1_000;
    vi.setSystemTime(nextMonday);
    const renewed = await acquire(h, sessionA, nextMonday + 24 * 60 * 60 * 1_000);
    expect(renewed.body.ok).toBe(true);
    expect(renewed.body.lease.startedAtMs).toBe(nextMonday);
  });

  it("clamps a Sunday-night lease at Monday 00:00 UTC", async () => {
    const sunday = Date.parse("2026-07-26T23:55:00.000Z");
    vi.setSystemTime(sunday);
    const h = harness();
    const result = await acquire(h, sessionA, sunday + 24 * 60 * 60 * 1_000);
    expect(result.body.lease.expiresAtMs - result.body.lease.startedAtMs).toBe(5 * 60_000);
  });

  it("fails closed when the budget reservation service is unavailable", async () => {
    const env = makeBaseEnv();
    const state = new MemoryDurableState();
    const quota = new UserQuota(state.asState(), env);
    const response = await quota.fetch(
      quotaRequest(env, "/acquire", {
        userId,
        sessionId: sessionA,
        sessionExpiresAtMs: monday + 86_400_000,
      }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()) as any).toMatchObject({ ok: false, code: "budget_unavailable" });
  });
});

describe("BudgetWindow Durable Object", () => {
  function budgetHarness() {
    const env = makeBaseEnv();
    const state = new MemoryDurableState();
    return { env, state, budget: new BudgetWindow(state.asState(), env) };
  }

  function reserveRequest(env: Env, reservationId: string, ceilingMicroUsd = 5_000) {
    return quotaRequest(env, "/reserve", {
      reservationId,
      windowKey: "2026-07-01",
      startsAtMs: Date.parse("2026-07-01T00:00:00Z"),
      endsAtMs: Date.parse("2026-08-01T00:00:00Z"),
      amountMicroUsd: 2_500,
      ceilingMicroUsd,
    });
  }

  it("serializes concurrent reservations against a hard ceiling", async () => {
    const h = budgetHarness();
    const responses = await Promise.all([
      h.budget.fetch(reserveRequest(h.env, "user_1:lease_1")),
      h.budget.fetch(reserveRequest(h.env, "user_2:lease_2")),
      h.budget.fetch(reserveRequest(h.env, "user_3:lease_3")),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    expect(h.state.storageImpl.values.get("totalMicroUsd")).toBe(5_000);
  });

  it("makes reservation IDs idempotent without double counting", async () => {
    const h = budgetHarness();
    expect((await h.budget.fetch(reserveRequest(h.env, "user_1:lease_1"))).status).toBe(200);
    const retry = await h.budget.fetch(reserveRequest(h.env, "user_1:lease_1"));
    expect((await retry.json()) as any).toMatchObject({ ok: true, idempotent: true, reservedMicroUsd: 2_500 });
  });

  it("rejects a mismatched window identity in the same Durable Object", async () => {
    const h = budgetHarness();
    await h.budget.fetch(reserveRequest(h.env, "user_1:lease_1"));
    const bad = quotaRequest(h.env, "/reserve", {
      reservationId: "user_2:lease_2",
      windowKey: "wrong-window",
      startsAtMs: 1,
      endsAtMs: 2,
      amountMicroUsd: 2_500,
      ceilingMicroUsd: 5_000,
    });
    expect((await h.budget.fetch(bad)).status).toBe(409);
  });

  it("requires the internal token", async () => {
    const h = budgetHarness();
    const request = reserveRequest(h.env, "user_1:lease_1");
    request.headers.set("X-Relay-Internal", "wrong");
    expect((await h.budget.fetch(request)).status).toBe(403);
  });
});
