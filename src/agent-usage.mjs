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
export function formatAgentUsage(usage = {}) {
  const n = (value) => tokenCount(value).toLocaleString();
  const parts = [
    `${n(usage.inputTokens)} in / ${n(usage.outputTokens)} out`,
    `${n(usage.cacheReadTokens)} cache read`,
  ];
  if (tokenCount(usage.cacheWriteTokens) > 0) parts.push(`${n(usage.cacheWriteTokens)} cache write`);
  parts.push(`context ${n(usage.context)}`);
  return parts.join(" · ");
}
