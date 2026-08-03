export const PUBLIC_SEARCH_BLOCK_ADVICE: string;
export const SEARCH_CHALLENGE_ADVICE: string;

export interface BotChallenge {
  type: "bot_challenge";
  provider: string;
  url: string;
  challengeUrl: string;
  detectedIn: string;
  signal: string;
  solve: {
    maxAttempts: number;
    resumeOnClear: boolean;
    helpers: readonly string[];
  };
  advice: string;
}

export const CHALLENGE_BLOCK_WINDOW_MS: number;
export const CHALLENGE_UNREAD_FRAME_BUDGET: number;

export interface ChallengeScanState {
  /** Providers left unresolved by the previous completed scan. */
  openProviders?: { size: number } | readonly unknown[];
  /** Epoch ms of the last 403/429/503 main-document response, 0 if none. */
  blockedAt?: number;
  /** Epoch ms to compare `blockedAt` against; defaults to `Date.now()`. */
  now?: number;
  main?: { url?: string; title?: string; text?: string };
  /** Every frame the full scan would read, with whatever is already known. */
  frames?: readonly {
    url?: string;
    title?: string;
    text?: string;
    visible?: boolean | null;
    /** `true` only when `text` is the frame's real text; absent means unread. */
    readable?: boolean;
  }[];
  solvedProviders?: readonly string[];
}

export function challengeScanNeeded(state?: ChallengeScanState): boolean;
export function detectBotChallenge(metadata?: unknown): BotChallenge | null;
export function frameUrlLooksLikeChallenge(url: string): boolean;
export function isPublicSearchNavigation(url: string): boolean;
