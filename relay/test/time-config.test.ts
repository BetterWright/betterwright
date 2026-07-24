import { describe, expect, it } from "vitest";
import { ConfigurationError, getConfig, requireSecret, usdToMicroUsd } from "../src/config";
import { billingWindow, isoWeekWindow } from "../src/time";
import { makeBaseEnv } from "./helpers";

describe("ISO-week accounting windows", () => {
  it.each([
    ["2026-07-20T00:00:00.000Z", "2026-07-20", "2026-07-27T00:00:00.000Z"],
    ["2026-07-26T23:59:59.999Z", "2026-07-20", "2026-07-27T00:00:00.000Z"],
    ["2026-07-27T00:00:00.000Z", "2026-07-27", "2026-08-03T00:00:00.000Z"],
    ["2026-01-01T12:00:00.000Z", "2025-12-29", "2026-01-05T00:00:00.000Z"],
  ])("uses Monday UTC for %s", (instant, key, ending) => {
    const window = isoWeekWindow(Date.parse(instant));
    expect(window.key).toBe(key);
    expect(new Date(window.startsAtMs).getUTCDay()).toBe(1);
    expect(new Date(window.endsAtMs).toISOString()).toBe(ending);
    expect(window.endsAtMs - window.startsAtMs).toBe(7 * 24 * 60 * 60 * 1_000);
  });
});

describe("billing windows", () => {
  it("uses a monthly UTC window anchored to the configured day", () => {
    const before = billingWindow(Date.parse("2026-07-14T23:59:59Z"), 15);
    expect(new Date(before.startsAtMs).toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(new Date(before.endsAtMs).toISOString()).toBe("2026-07-15T00:00:00.000Z");
    const on = billingWindow(Date.parse("2026-07-15T00:00:00Z"), 15);
    expect(on.key).toBe("2026-07-15");
    expect(new Date(on.endsAtMs).toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("supports an operator-supplied contractual period key without changing boundaries", () => {
    const window = billingWindow(Date.parse("2026-07-24T00:00:00Z"), 1, "invoice-2026-07");
    expect(window.key).toBe("invoice-2026-07");
    expect(new Date(window.startsAtMs).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("environment parsing", () => {
  it("loads the reviewed two-hour, 15-minute, $0.0025, and $900 defaults", () => {
    const config = getConfig(makeBaseEnv());
    expect(config.weeklyViewerMs).toBe(7_200_000);
    expect(config.leaseMs).toBe(900_000);
    expect(config.leaseReservationMicroUsd).toBe(2_500);
    expect(config.budgetCeilingMicroUsd).toBe(900_000_000);
    expect(config.maxMessageBytes).toBe(2 * 1024 * 1024);
    expect(config.sustainedMessagesPerSecond).toBe(15);
    expect(config.burstMessages).toBe(20);
    expect(config.maxBytesPerSecond).toBe(1_250_000);
  });

  it("parses USD exactly to integer micro-dollars", () => {
    expect(usdToMicroUsd("0.0025", "cost")).toBe(2_500);
    expect(usdToMicroUsd("900", "ceiling")).toBe(900_000_000);
    expect(usdToMicroUsd("1.000001", "cost")).toBe(1_000_001);
    expect(() => usdToMicroUsd("0.0000001", "cost")).toThrow(ConfigurationError);
    expect(() => usdToMicroUsd("-1", "cost")).toThrow(ConfigurationError);
    expect(() => usdToMicroUsd("NaN", "cost")).toThrow(ConfigurationError);
  });

  it("accepts intentional numeric overrides and a fixed billing key", () => {
    const config = getConfig(
      makeBaseEnv({
        WEEKLY_VIEWER_SECONDS: "3600",
        LEASE_SECONDS: "600",
        LEASE_RESERVATION_USD: "0.004",
        BUDGET_CEILING_USD: "100",
        BILLING_WINDOW_ID: "contract:2026-07",
        RELAY_KILL_SWITCH: "yes",
      }),
    );
    expect(config.weeklyViewerMs).toBe(3_600_000);
    expect(config.leaseMs).toBe(600_000);
    expect(config.leaseReservationMicroUsd).toBe(4_000);
    expect(config.budgetCeilingMicroUsd).toBe(100_000_000);
    expect(config.billingWindowId).toBe("contract:2026-07");
    expect(config.envKillSwitch).toBe(true);
  });

  it.each([
    ["PUBLIC_ORIGIN", "https://relay.example.com/path"],
    ["PUBLIC_ORIGIN", "https://*.example.com"],
    ["PUBLIC_ORIGIN", "http://relay.example.com"],
    ["APP_ORIGIN", "https://app.example.com?x=1"],
    ["CLERK_AUTHORIZED_PARTIES", "https://app.example.com/path"],
  ])("rejects non-exact %s value", (field, value) => {
    expect(() => getConfig(makeBaseEnv({ [field]: value }))).toThrow(ConfigurationError);
  });

  it("permits plain HTTP only on loopback for local development", () => {
    const config = getConfig(
      makeBaseEnv({
        PUBLIC_ORIGIN: "http://localhost:8787",
        APP_ORIGIN: "http://127.0.0.1:3000",
        CLERK_AUTHORIZED_PARTIES: "http://127.0.0.1:3000",
      }),
    );
    expect(config.publicOrigin).toBe("http://localhost:8787");
  });

  it("rejects short deployment secrets", () => {
    expect(() => requireSecret(makeBaseEnv({ ADMIN_TOKEN: "short" }), "ADMIN_TOKEN")).toThrow(
      ConfigurationError,
    );
  });
});
