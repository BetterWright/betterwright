import type { DownloadPolicy, HeadlessMode } from "./common.js";
import type { NetworkPolicy } from "./policy.js";

export interface McpContentBlock {
  type: string;
  [key: string]: unknown;
}

/** Build a NetworkPolicy from BETTERWRIGHT_* environment variables. */
export function policyFromEnv(
  env?: Record<string, string | undefined>,
): NetworkPolicy;

/** Read BETTERWRIGHT_DOWNLOAD_POLICY; throws on an invalid value. */
export function downloadPolicyFromEnv(
  env?: Record<string, string | undefined>,
): DownloadPolicy;

/** Read BETTERWRIGHT_HEADLESS; defaults to "auto" when unset. */
export function headlessFromEnv(
  env?: Record<string, string | undefined>,
): HeadlessMode;

/** Convert a run result to MCP content: a JSON text summary then image blocks. */
export function contentForResult(result: unknown): Promise<McpContentBlock[]>;

/**
 * Serve BetterWright over the MCP stdio transport until the client
 * disconnects. Requires the optional `@modelcontextprotocol/sdk` peer
 * dependency; rejects with installation guidance when it is missing.
 */
export function runMcpServer(
  env?: Record<string, string | undefined>,
  options?: {
    /** Credential vault enabling `browser_login`; omit and logins use an
     * unlocked password-manager extension instead. */
    vault?: {
      handleRequest(action: string, payload: unknown, origin: string): Promise<unknown>;
      redact?(value: unknown): unknown;
    };
  },
): Promise<void>;
