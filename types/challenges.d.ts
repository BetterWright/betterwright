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

export function detectBotChallenge(metadata?: unknown): BotChallenge | null;
export function isPublicSearchNavigation(url: string): boolean;
