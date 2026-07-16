export const CAPTCHA_SOLVE_STATUSES: Readonly<{
  READY: "ready";
  PROCESSING: "processing";
  ERROR: "error";
}>;

export const CAPTCHA_STAGES: Readonly<{
  NONE: "none";
  CHECKBOX: "checkbox";
  TURNSTILE: "turnstile";
  MANAGED: "managed_challenge";
  IMAGE_GRID: "image_grid";
  SLIDER: "slider";
  TEXT: "text";
  INVISIBLE: "invisible";
  UNKNOWN: "unknown";
}>;

export const CAPTCHA_PROVIDERS: readonly string[];

export interface ChallengeStageClassification {
  stage: string;
  provider: string;
  signal: string | null;
  source: {
    kind: string;
    url: string;
    index: number | null;
  };
  autoSolvable: boolean;
  needsVision: boolean;
}

export interface CaptchaSolveResult {
  status: "ready" | "processing" | "error" | string;
  request: string;
  requestId: string;
  provider: string;
  stage: string;
  cleared: boolean;
  token: string | null;
  errorCode: string | null;
  errorText: string | null;
  attempts: unknown[];
  artifact: unknown;
  tiles: unknown;
  instruction: string | null;
  challenge: unknown;
  local: true;
  externalApi: false;
}

export interface SolveAction {
  action: string;
  waitMs: number;
  description: string;
}

export function classifyChallengeStage(metadata?: unknown): ChallengeStageClassification;
export function buildSolveResult(input?: Partial<CaptchaSolveResult> & {
  status?: string;
  requestId?: string | null;
}): CaptchaSolveResult;
export function nextSolveAction(
  classification: { stage?: string } | null | undefined,
  attemptIndex?: number,
): SolveAction;
export function maxAutoStages(options?: { maxStages?: number; maxAttempts?: number }): number;
export function solveTimeoutMs(options?: { timeout?: number; timeoutMs?: number }): number;

export const WIDGET_FRAME_PATTERNS: Readonly<Record<string, RegExp>>;
export const CHECKBOX_SELECTORS: readonly string[];
export const VERIFY_BUTTON_SELECTORS: readonly string[];
export const SLIDER_SELECTORS: readonly string[];
export const IMAGE_TILE_SELECTORS: readonly string[];
