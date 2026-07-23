import type {
  DownloadPolicy,
  FillCredentialOptions,
  GenerateAndFillCredentialOptions,
  HeadlessMode,
} from "./common.js";
import type { NetworkPolicy } from "./policy.js";

export interface McpContentBlock {
  type: string;
  [key: string]: unknown;
}

export type BrowserLoginOptions =
  | (FillCredentialOptions & { generate: false })
  | (GenerateAndFillCredentialOptions & { generate: true });

export const LOGIN_INPUT_SCHEMA: Readonly<object>;

/** Keep and validate the recognized `browser_login` arguments. */
export function loginOptionsFromArgs(
  args?: Record<string, unknown>,
): BrowserLoginOptions;

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

/** Read BETTERWRIGHT_LIVE_VIEW / _HOST / _PORT for the browser_handoff tool. */
export function liveViewFromEnv(env?: Record<string, string | undefined>): {
  enabled: boolean;
  host: string;
  port: number;
};

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
    /** Custom credential vault, or false/null to disable the built-in vault. */
    vault?: false | null | {
      handleRequest(action: string, payload: unknown, origin: string): Promise<unknown>;
      redact?(value: unknown): unknown;
    };
  },
): Promise<void>;
