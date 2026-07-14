export type BrowserFlavor = "cloak" | "chromium";
export type HeadlessMode = boolean | "auto";
export type PublicSearchPolicy = "block" | "allow";
export type DownloadPolicy = "ask" | "allow" | "deny";

export interface CredentialVault {
  handleRequest(
    action: string,
    payload: Record<string, unknown>,
    origin: string,
  ): unknown | Promise<unknown>;
  redact?(value: unknown): unknown;
}

export interface BetterWrightArtifact {
  kind?: string;
  path?: string;
  media?: string;
  size?: number;
  [key: string]: unknown;
}

export interface ResultEnvelopeBase {
  console?: unknown[];
  events?: unknown[];
  artifacts?: BetterWrightArtifact[];
  warnings?: string[];
  challenges?: unknown[];
  pages?: unknown[];
  profileMode?: string;
  durationMs?: number;
  envelopeTruncated?: boolean;
}

export interface SuccessfulRunResult<T = unknown> extends ResultEnvelopeBase {
  ok: true;
  result: T;
  error?: never;
}

export interface FailedRunResult extends ResultEnvelopeBase {
  ok: false;
  error: string;
  result?: never;
}

export type RunResult<T = unknown> = SuccessfulRunResult<T> | FailedRunResult;

export interface RunOptions {
  session?: string;
  /** Optional host-facing status text. It is never evaluated in the browser sandbox. */
  note?: string;
  timeout?: number;
  approvedDownloads?: boolean;
}

export interface FillCredentialOptions {
  passwordSelector: string;
  usernameSelector?: string;
  confirmPasswordSelector?: string;
  submitSelector?: string;
  id?: string;
  username?: string;
  session?: string;
  timeout?: number;
}

export interface GenerateAndFillCredentialOptions extends FillCredentialOptions {
  length?: number;
  includeSymbols?: boolean;
  label?: string | null;
}

export interface CredentialPublicRecord {
  filled: Array<"username" | "password" | "confirmPassword">;
  submitted: boolean;
  [key: string]: unknown;
}

export type CredentialFillResult =
  | (ResultEnvelopeBase & {
      ok: true;
      result: CredentialPublicRecord;
      error?: never;
    })
  | (ResultEnvelopeBase & {
      ok: false;
      error: string;
      result?: never;
    });
