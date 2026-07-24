import { describe, expect, it } from "vitest";
import { consumeRate, initialRateState, type RatePolicy } from "../src/rate-limit";

const policy: RatePolicy = {
  sustainedMessagesPerSecond: 15,
  burstMessages: 20,
  maxBytesPerSecond: 1_250_000,
  byteBurstCapacity: 2 * 1024 * 1024,
};

describe("relay token buckets", () => {
  it("allows a 20-message burst and then enforces 15 messages per second", () => {
    let state = initialRateState(policy, 1_000);
    for (let index = 0; index < 20; index += 1) {
      const decision = consumeRate(state, 1, 1_000, policy);
      expect(decision.allowed).toBe(true);
      state = decision.state;
    }
    const blocked = consumeRate(state, 1, 1_000, policy);
    expect(blocked).toMatchObject({ allowed: false, reason: "message_rate" });
    state = blocked.state;
    for (let index = 0; index < 15; index += 1) {
      const decision = consumeRate(state, 1, 2_000, policy);
      expect(decision.allowed).toBe(true);
      state = decision.state;
    }
    expect(consumeRate(state, 1, 2_000, policy)).toMatchObject({
      allowed: false,
      reason: "message_rate",
    });
  });

  it("permits one maximum-sized envelope but refills at only 10 Mbps", () => {
    let state = initialRateState(policy, 0);
    const maximum = consumeRate(state, 2 * 1024 * 1024, 0, policy);
    expect(maximum.allowed).toBe(true);
    state = maximum.state;
    expect(consumeRate(state, 1, 0, policy)).toMatchObject({ allowed: false, reason: "bandwidth" });

    const afterOneSecond = consumeRate(state, 1_250_000, 1_000, policy);
    expect(afterOneSecond.allowed).toBe(true);
    expect(afterOneSecond.state.byteTokens).toBeCloseTo(0, 6);
  });

  it("does not create tokens when clocks move backwards and caps long-idle accumulation", () => {
    const initial = initialRateState(policy, 5_000);
    const one = consumeRate(initial, 100, 5_000, policy);
    const backward = consumeRate(one.state, 100, 4_000, policy);
    expect(backward.state.messageTokens).toBe(18);
    const longIdle = consumeRate(backward.state, 1, 1_000_000, policy);
    expect(longIdle.allowed).toBe(true);
    expect(longIdle.state.messageTokens).toBe(19);
    expect(longIdle.state.byteTokens).toBe(policy.byteBurstCapacity - 1);
  });

  it("checks message rate before bandwidth without consuming either on denial", () => {
    const emptyMessages = { messageTokens: 0, byteTokens: 0, updatedAtMs: 0 };
    const decision = consumeRate(emptyMessages, 999, 0, policy);
    expect(decision.reason).toBe("message_rate");
    expect(decision.state).toEqual(emptyMessages);
  });
});
