function tokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

// Providers report cached reads as a subset of their total prompt input. The
// user-facing input figure is the portion that was not served from that cache.
export function uncachedInputTokens(totalInputTokens, cacheReadTokens) {
  return Math.max(0, tokenCount(totalInputTokens) - tokenCount(cacheReadTokens));
}

// Shared by `exec` and the interactive console so both CLI surfaces describe
// cost the same way. Cache writes are useful only when a provider reports a real
// positive count; an omitted/zero field should not imply that every fresh input
// token was written to cache.
export function formatAgentUsage(usage: any = {}) {
  const n = (value) => tokenCount(value).toLocaleString();
  const parts = [
    `${n(usage.inputTokens)} in / ${n(usage.outputTokens)} out`,
    `${n(usage.cacheReadTokens)} cache read`,
  ];
  if (tokenCount(usage.cacheWriteTokens) > 0) parts.push(`${n(usage.cacheWriteTokens)} cache write`);
  parts.push(`context ${n(usage.context)}`);
  return parts.join(" · ");
}

// Session totals for the interactive console. Steps, tool calls, duration, and
// token counts add across tasks; `context` stays the latest prompt size.
export function emptyAgentRunTotals() {
  return {
    steps: 0,
    toolCalls: 0,
    durationMs: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      context: 0,
    },
  };
}

export function accumulateAgentRun(total, result) {
  const prior = total || emptyAgentRunTotals();
  const usage = result?.usage || {};
  return {
    steps: (prior.steps || 0) + (result?.steps || 0),
    toolCalls: (prior.toolCalls || 0) + (result?.toolCalls || 0),
    durationMs: (prior.durationMs || 0) + (result?.durationMs || 0),
    usage: {
      inputTokens: tokenCount(prior.usage?.inputTokens) + tokenCount(usage.inputTokens),
      outputTokens: tokenCount(prior.usage?.outputTokens) + tokenCount(usage.outputTokens),
      cacheReadTokens: tokenCount(prior.usage?.cacheReadTokens) + tokenCount(usage.cacheReadTokens),
      cacheWriteTokens: tokenCount(prior.usage?.cacheWriteTokens) + tokenCount(usage.cacheWriteTokens),
      context: tokenCount(usage.context) || tokenCount(prior.usage?.context),
    },
  };
}
