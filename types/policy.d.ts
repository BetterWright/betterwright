import type { UntrustedValue } from "./untrusted-value.js";

/** The verdict a policy returns for one request. */
export interface NetworkDecision {
  allowed: boolean;
  /** Why a request was denied; surfaced in worker warnings and errors. */
  reason?: string;
}

/**
 * What the worker knows about a request: `method`, `resourceType`,
 * `isNavigation`, and `resolvedFrom` when the connect target is a resolved
 * address literal. Custom hooks may key decisions on any of these.
 */
export interface NetworkRequestDetails {
  [key: string]: UntrustedValue;
}

/**
 * Final say on a request, evaluated last. Return a decision to override the
 * built-in rules, or `null`/`undefined` to keep the decision made so far. An
 * `allowed: true` from this hook still cannot reach a metadata endpoint. A
 * policy carrying a hook is never answerable from the worker's decision cache:
 * every request reaches it.
 */
export type NetworkPolicyCustom = (
  url: string,
  details: NetworkRequestDetails,
) => NetworkDecision | null | undefined;

export interface NetworkPolicyOptions {
  /**
   * Permit RFC 1918 ranges, link-local, and `*.internal`/`*.local`/`*.lan`
   * hosts. Implies loopback. Default `true`; set `false` to restrict the
   * browser to the public internet plus `allowHosts`.
   */
  allowPrivateNetwork?: boolean;
  /**
   * Permit `127.0.0.1`/`localhost` for local dev servers. Does not open the
   * wider private network. Default `true`.
   */
  allowLoopback?: boolean;
  /**
   * Re-allow these hosts inside an otherwise blocked scope. An entry matches
   * a host exactly or as a parent domain; add `:port` to pin a port. This is
   * an exception list, not an exclusive allowlist: other public sites stay
   * reachable.
   */
  allowHosts?: string[];
  /** Deny these hosts ahead of `allowHosts` and the private-network rules. */
  blockHosts?: string[];
  /** A hook evaluated last; see `NetworkPolicyCustom`. */
  custom?: NetworkPolicyCustom;
}

/**
 * Cloud instance-metadata hostnames in the unliftable floor
 * (`metadata.google.internal`, `metadata.goog`). Nothing can allowlist them:
 * not `allowHosts`, not `custom`, not a subclass.
 */
export const METADATA_HOSTNAMES: Set<string>;

/**
 * Cloud instance-metadata addresses in the same floor
 * (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::…`).
 */
export const METADATA_ADDRESSES: Set<string>;

/**
 * The allow/deny rules applied to every browser request: navigations,
 * subresources, WebSocket upgrades, and the transport connections the worker's
 * guard proxy makes on the browser's behalf.
 *
 * Defaults permit the public internet, private networks, and loopback while
 * blocking non-web schemes and the metadata floor. Decisions from a stock
 * policy may be reused by the worker's five-second cache; a `custom` hook,
 * a subclass, or any other `check` implementation is asked every time.
 * Evaluation order: scheme, metadata floor, `blockHosts`, `allowHosts`,
 * private-network rules, `custom`. A check that throws denies the request.
 *
 * For ordinary remote CDP/provider browsers the transport floor does not
 * apply; supported Playwright routing checks still do. See
 * docs/network-policy.md.
 */
export class NetworkPolicy {
  constructor(options?: NetworkPolicyOptions);

  allowPrivateNetwork: boolean;
  allowLoopback: boolean;
  allowHosts: string[];
  blockHosts: string[];
  custom: NetworkPolicyCustom | null;

  /** Does an `allowHosts`/`blockHosts` entry cover this host (and port)? */
  hostMatches(entry: UntrustedValue, hostname: string, port: number | null): boolean;
  /** Is this hostname in the unliftable metadata floor? */
  isMetadata(hostname: string): boolean;
  /** Decide one request URL with its request details. */
  check(url: UntrustedValue, details?: NetworkRequestDetails): NetworkDecision;
  /** Decide a connect target the transport guard resolved to. */
  checkHost(hostname: string, port: number | null): NetworkDecision;
}
