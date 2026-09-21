import type { UntrustedValue } from "./untrusted-value.js";

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

/** Scan page metadata for a known bot challenge; null when none matches. */
export function detectBotChallenge(metadata?: UntrustedValue): BotChallenge | null;
