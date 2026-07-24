export interface RateState {
  messageTokens: number;
  byteTokens: number;
  updatedAtMs: number;
}

export interface RatePolicy {
  sustainedMessagesPerSecond: number;
  burstMessages: number;
  maxBytesPerSecond: number;
  byteBurstCapacity: number;
}

export interface RateDecision {
  allowed: boolean;
  state: RateState;
  reason?: "message_rate" | "bandwidth";
}

export function initialRateState(policy: RatePolicy, nowMs: number): RateState {
  return {
    messageTokens: policy.burstMessages,
    byteTokens: policy.byteBurstCapacity,
    updatedAtMs: nowMs,
  };
}

/** Token buckets provide 15 messages/s sustained, 20 burst, and 10 Mbps by default. */
export function consumeRate(
  previous: RateState,
  byteLength: number,
  nowMs: number,
  policy: RatePolicy,
): RateDecision {
  const elapsedSeconds = Math.max(0, nowMs - previous.updatedAtMs) / 1_000;
  const messageTokens = Math.min(
    policy.burstMessages,
    previous.messageTokens + elapsedSeconds * policy.sustainedMessagesPerSecond,
  );
  const byteTokens = Math.min(
    policy.byteBurstCapacity,
    previous.byteTokens + elapsedSeconds * policy.maxBytesPerSecond,
  );
  const replenished: RateState = { messageTokens, byteTokens, updatedAtMs: nowMs };

  if (messageTokens < 1) return { allowed: false, state: replenished, reason: "message_rate" };
  if (byteTokens < byteLength) return { allowed: false, state: replenished, reason: "bandwidth" };
  return {
    allowed: true,
    state: {
      messageTokens: messageTokens - 1,
      byteTokens: byteTokens - byteLength,
      updatedAtMs: nowMs,
    },
  };
}
