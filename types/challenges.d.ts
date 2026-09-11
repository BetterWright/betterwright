import type { UntrustedValue } from "./untrusted-value.js";

/** Guidance text returned when `publicSearchPolicy: "block"` stops a navigation. */
export const PUBLIC_SEARCH_BLOCK_ADVICE: string;
/** Guidance text attached to a detected search-provider challenge. */
export const SEARCH_CHALLENGE_ADVICE: string;

/** A detected bot challenge as results report it to the caller. */
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

/** How long a recorded 403/429/503 block keeps forcing the full challenge scan. */
export const CHALLENGE_BLOCK_WINDOW_MS: number;
/**
 * Up to this many unreadable frames force the full scan (reading them costs
 * less than the round trips the gate saves). Past the budget, only a
 * challenge-looking frame URL triggers it.
 */
export const CHALLENGE_UNREAD_FRAME_BUDGET: number;

/** Cheap per-run state used to decide whether a full challenge scan is due. */
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

/** Should the worker pay for a full challenge scan before this run? */
export function challengeScanNeeded(state?: ChallengeScanState): boolean;
/** Scan page metadata for a known bot challenge; null when none matches. */
export function detectBotChallenge(metadata?: UntrustedValue): BotChallenge | null;
/** Does this frame URL host a challenge widget? */
export function frameUrlLooksLikeChallenge(url: string): boolean;
/** Is this navigation targeting a public search-result UI? */
export function isPublicSearchNavigation(url: string): boolean;
