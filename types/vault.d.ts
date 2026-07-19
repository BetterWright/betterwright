export type VaultCategory =
  | "login"
  | "credit-card"
  | "identity"
  | "api-credential"
  | "secure-note"
  | "ssh-key";

export type VaultMatchMode = "base-domain" | "host" | "exact-origin" | "never";

export interface LocalCredentialVaultOptions {
  /** Exact vault directory. Takes precedence over `home`. */
  dir?: string;
  /** BetterWright home directory; the vault is stored in its `vault` child. */
  home?: string;
  /**
   * Normal generated-secret finalization window. After this threshold, the
   * encrypted pending secret remains recoverable only by its exact pendingId
   * until it is explicitly committed or discarded. Defaults to 60 seconds.
   */
  pendingTtlMs?: number;
  /** Maximum wait for another process holding the vault lock. */
  lockTimeoutMs?: number;
  /** Age after which a malformed or orphaned lock can be recovered. */
  staleLockMs?: number;
}

export interface VaultPublicRecord {
  id: string;
  origin: string;
  matchMode: VaultMatchMode;
  username: string;
  label: string | null;
  category: VaultCategory;
  createdAt: string;
  updatedAt: string;
}

export class LocalCredentialVaultError extends Error {
  code: string;
}

export class LocalCredentialVault {
  constructor(options?: string | LocalCredentialVaultOptions);

  readonly dir: string;
  readonly paths: Readonly<{
    key: string;
    data: string;
    audit: string;
    lock: string;
  }>;
  readonly pendingTtlMs: number;
  readonly lockTimeoutMs: number;
  readonly staleLockMs: number;

  handleRequest(
    action:
      | "list"
      | "list-pending"
      | "save"
      | "update"
      | "remove"
      | "fill"
      | "generate"
      | "commit"
      | "discard",
    /** `generate` accepts an idempotency `pendingId`; finalization requires it. */
    payload: Record<string, unknown> | undefined,
    origin: string,
  ): Promise<unknown>;

  /** Return a cloned value with every active secret replaced. */
  redact<T>(value: T): T;

  /** Clear tracked material after every page in the owning worker is closed. */
  resetRedactionSecrets(): void;
}

export const VAULT_CATEGORIES: readonly VaultCategory[];
export const VAULT_MATCH_MODES: readonly VaultMatchMode[];

export function createLocalCredentialVault(
  options?: string | LocalCredentialVaultOptions,
): LocalCredentialVault;
