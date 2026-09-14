import type { RunResult } from "./common.js";

export interface HostConnection {
  /** A capability-authenticated CDP endpoint exposing exactly one tab. */
  provider: { cdpUrl: string; headers?: Record<string, string> };
  /** True as soon as the lease is revoked or teardown starts, even before close() settles.
   * The next explicit operation replaces its stale worker before sending any code.
   * Omit only when the adapter cannot report transport lifetime synchronously.
   */
  readonly closed?: boolean;
  /** Revoke input authority, disconnect and drain pending commands. Never close the page. */
  close(): Promise<void>;
}

export interface HostTarget {
  /** Configure the dedicated session to use this SOCKS guard before exposing the tab. */
  connect(options: { proxyUrl: string }): Promise<HostConnection>;
  /** Optional lease around run() and syncCookies(); abort its signal to hand control
   * back to the human. In-flight worker operations drain before the promise settles.
   * Cookie Sync successes use result to carry their CookieSyncResult inside this lease.
   */
  run?(operation: (signal?: AbortSignal) => Promise<RunResult>): Promise<RunResult>;
}
