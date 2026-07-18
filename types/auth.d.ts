/** Result of a successful OAuth login. */
export interface LoginResult {
  provider: string;
  file: string;
  accountId: string | null;
  email: string | null;
}

export interface LoginProviderOptions {
  provider: "codex" | "grok";
  onUrl?: (url: string) => void;
  log?: (line: string) => void;
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

export function loginProvider(options: LoginProviderOptions): Promise<LoginResult>;

export function loadCodexAuth(): CodexAuth | null;
export function loadGrokAuth(): GrokAuth | null;

export function codexAccessToken(): Promise<{ accessToken: string; accountId: string | null }>;
export function grokAccessToken(): Promise<{ accessToken: string; accountId: string | null }>;
export function refreshCodexToken(): Promise<string>;
export function refreshGrokToken(): Promise<string>;

export function isJwtExpired(token: string, skewSeconds?: number): boolean;

export function codexHome(): string;
export function grokHome(): string;
