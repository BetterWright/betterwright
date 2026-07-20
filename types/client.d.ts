import type {
  BetterWrightOptions,
  CredentialFillResult,
  FillCredentialOptions,
  GenerateAndFillCredentialOptions,
  PendingCredentialListOptions,
  PendingCredentialListResult,
  PendingCredentialOptions,
  PendingCredentialResult,
  RunOptions,
  RunResult,
} from "./public.js";
import type { CredentialVault } from "./common.js";
import type { NetworkPolicy } from "./policy.js";
import type { VaultMatchMode } from "./vault.js";

export class BrowserError extends Error {}

export function validateCredentialMatchMode(value: unknown): VaultMatchMode;

export class BetterWright {
  constructor(options?: BetterWrightOptions);

  home: string;
  policy: NetworkPolicy;
  vault: CredentialVault | null;
  credentialCapture: boolean;
  browserFlavor: "cloak";
  headless: boolean;
  searchMinIntervalMs: number;
  publicSearchPolicy: "block" | "allow";
  downloadPolicy: "ask" | "allow" | "deny";
  stealthRuntimeFix: boolean;
  defaultTimeout: number;

  run<T = unknown>(code: string, options?: RunOptions): Promise<RunResult<T>>;
  fillCredential(options?: FillCredentialOptions): Promise<CredentialFillResult>;
  generateAndFillCredential(
    options?: GenerateAndFillCredentialOptions,
  ): Promise<CredentialFillResult>;
  commitGeneratedCredential(
    options: PendingCredentialOptions,
  ): Promise<PendingCredentialResult>;
  discardGeneratedCredential(
    options: PendingCredentialOptions,
  ): Promise<PendingCredentialResult>;
  listPendingCredentials(
    options?: PendingCredentialListOptions,
  ): Promise<PendingCredentialListResult>;
  close(): Promise<void>;
}
