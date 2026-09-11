/** Result of a successful OAuth login. */
export interface LoginResult {
  provider: string;
  file: string;
  accountId: string | null;
  email: string | null;
}

export interface LoginProviderOptions {
  provider: "codex" | "grok";
  /** Called with the authorization URL to show or open for the user. */
  onUrl?: (url: string) => void;
  /** Progress lines from the flow. */
  log?: (line: string) => void;
  /** Open the URL in the system browser instead of only reporting it. */
  open?: boolean;
  timeoutMs?: number;
}

/** Stored codex OAuth session. */
export interface CodexAuth {
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accountId: string | null;
  apiKey: string | null;
  lastRefresh: string | null;
}

/** Stored grok OAuth session. */
export interface GrokAuth {
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accountId: string | null;
  expiresAt: number | null;
}

/** Run the provider's OAuth PKCE flow and store the resulting tokens. */
export function loginProvider(options: LoginProviderOptions): Promise<LoginResult>;

/** Stored codex session, or null. BetterWright and the codex CLI share this file. */
export function loadCodexAuth(): CodexAuth | null;
/** Stored grok session, or null. */
export function loadGrokAuth(): GrokAuth | null;

/** A valid access token, refreshing when expired. Throws when not signed in. */
export function codexAccessToken(): Promise<{ accessToken: string; accountId: string | null }>;
/** A valid access token, refreshing when expired. Throws when not signed in. */
export function grokAccessToken(): Promise<{ accessToken: string; accountId: string | null }>;
/** Exchange the stored refresh token for a fresh access token and persist it. */
export function refreshCodexToken(): Promise<string>;
/** Exchange the stored refresh token for a fresh access token and persist it. */
export function refreshGrokToken(): Promise<string>;

/** A JWT is expired, or within `skewSeconds` (default 120) of it. */
export function isJwtExpired(token: string, skewSeconds?: number): boolean;

/** Directory holding the codex token file, under `BETTERWRIGHT_HOME`. */
export function codexHome(): string;
/** Directory holding the grok token file, under `BETTERWRIGHT_HOME`. */
export function grokHome(): string;
