// The worker's network guard entrypoint: turns a URL into a policy decision by
// asking the client over RPC, and caches the answers the client marks cacheable
// so a page pulling hundreds of subresources does not pay a round trip each.
//
// This module holds no policy of its own — decisions come from the client, which
// is the only process the policy and its custom hook live in.
//
// Security contract:
//   - Cacheability is asserted by the client and only by the client, which sets
//     `cacheable: true` solely for a stock NetworkPolicy with no custom hook —
//     the one shape whose verdict is a pure function of scheme, host, and port.
//     The worker never infers it: anything other than the literal `true`
//     (absent, false, a truthy non-boolean) means do not cache.
//   - Only host-scoped checks are cached. `fullUrl` checks (navigations,
//     documents, downloads, websockets) carry a path and details no host key can
//     represent, so they always reach the client.
//   - The key reads the port the same way NetworkPolicy does — straight off the
//     parsed URL (`src/policy.ts` check) — so two URLs share a key exactly when
//     the policy cannot tell them apart. WHATWG parsing already erases a
//     scheme's default port, which is why `https://h/` and `https://h:443/` are
//     one entry; a port written into the key by any other route would have to
//     re-derive that equivalence and could drift from it.
//   - Failures are never cached. An RPC rejection propagates unchanged and
//     leaves no entry, so the transport still fails closed on the next attempt.
//   - allowHosts/blockHosts are public mutable arrays, so entries expire after
//     `ttlMs` instead of living for the session.
//   - The cache belongs to the guard it was created with. A worker process
//     serves one BetterWright and therefore one policy, so decisions made under
//     one policy can never answer for another.

export const GUARD_CACHE_TTL_MS = 5_000;
export const GUARD_CACHE_MAX = 2_048;

const BROWSER_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

type GuardDecision = { allowed: boolean; reason?: string };

/**
 * Build the worker's `guardUrl`, backed by a cache private to this instance.
 *
 * @param {object} options
 * @param {Function} options.rpc `(method, payload, executeId) => Promise<any>`
 * @param {Function} [options.now] clock source, for tests
 * @param {number} [options.ttlMs] entry lifetime
 * @param {number} [options.max] entry ceiling before the oldest is evicted
 */
export function createGuardUrl({
  rpc,
  now = Date.now,
  ttlMs = GUARD_CACHE_TTL_MS,
  max = GUARD_CACHE_MAX,
}) {
  const cache = new Map<string, { at: number; decision: GuardDecision }>();

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (now() - hit.at > ttlMs) {
      cache.delete(key);
      return null;
    }
    return hit.decision;
  }

  function cacheSet(key, decision) {
    if (cache.size >= max && !cache.has(key)) {
      // Map iteration order is insertion order, so the first key is the oldest.
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { at: now(), decision });
  }

  return async function guardUrl(url, details, executeId): Promise<any> {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: "invalid URL" };
    }
    const scheme = parsed.protocol.toLowerCase();
    if (scheme === "about:" && url === "about:blank") return { allowed: true };
    if (scheme === "data:" || scheme === "blob:") return { allowed: true };
    if (!BROWSER_SCHEMES.has(scheme)) {
      return {
        allowed: false,
        reason: `unsupported browser URL scheme: ${scheme}`,
      };
    }
    const fullUrl = Boolean(
      details?.isNavigation ||
      details?.resourceType === "document" ||
      details?.resourceType === "download" ||
      scheme === "ws:" ||
      scheme === "wss:",
    );
    const key = fullUrl
      ? ""
      : `${scheme}//${parsed.hostname.toLowerCase()}:${parsed.port}`;
    if (key) {
      // Copy on read: a caller must not be able to mutate a cached verdict.
      const cached = cacheGet(key);
      if (cached) return { ...cached };
    }
    const response = await rpc("guard", { url, ...details, fullUrl }, executeId);
    if (key && response?.cacheable === true) {
      const decision: GuardDecision = { allowed: response.allowed === true };
      if (typeof response.reason === "string") decision.reason = response.reason;
      cacheSet(key, decision);
    }
    return response;
  };
}
