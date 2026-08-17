import type { UntrustedValue } from "./untrusted-value.js";

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
  MOTION: "motion";
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
  grid: unknown;
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

export function classifyChallengeStage(metadata?: UntrustedValue): ChallengeStageClassification;
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
export const MOTION_CONFIRM_SELECTORS: readonly string[];
export const IMAGE_TILE_SELECTORS: readonly string[];
export const CHALLENGE_WIDGET_SELECTORS: readonly string[];
export const CHALLENGE_INSTRUCTION_SELECTORS: readonly string[];

export function parseTileIndexes(value?: UntrustedValue): number[];
export function dedupeBoxes(
  boxes?: Array<{ x?: number; y?: number; width?: number; height?: number }>,
  quantum?: number,
): Array<{ x: number; y: number; width: number; height: number }>;
export function sortTilesReadingOrder(
  boxes?: Array<{ x: number; y: number; width: number; height: number }>,
  yTolerance?: number,
): Array<{ x: number; y: number; width: number; height: number }>;
export function clusterSimilarBoxes(
  boxes?: Array<{ x?: number; y?: number; width?: number; height?: number }>,
  options?: { minCount?: number; sizeSlack?: number },
): Array<{ x: number; y: number; width: number; height: number }>;
export function collapseNestedBoxes(
  boxes?: Array<{ x?: number; y?: number; width?: number; height?: number }>,
  options?: { overlap?: number; minAreaRatio?: number },
): Array<{ x: number; y: number; width: number; height: number }>;
export function isCaptchaChromeLabel(label?: UntrustedValue): boolean;
export function isCaptchaSkipSubmitLabel(label?: UntrustedValue): boolean;
export function isCaptchaVerifySubmitLabel(label?: UntrustedValue): boolean;
export function isPlausibleImageGrid(
  boxes?: UntrustedValue,
  options?: { minTiles?: number; minSide?: number },
): boolean;
export function pickBestTileSet(sets?: UntrustedValue): Array<{
  index: number;
  bounds: { x: number; y: number; width: number; height: number };
  label: string | null;
}>;
export function publicCaptchaTiles(tiles?: UntrustedValue): Array<{
  index: number;
  bounds: { x: number; y: number; width: number; height: number };
  x: number;
  y: number;
  width: number;
  height: number;
  label: string | null;
}> | null;
export function gridFromTiles(tiles?: UntrustedValue): { rows: number; cols: number };
export function inferGridTiles(
  box: { x?: number; y?: number; width?: number; height?: number },
  cols?: number,
  rows?: number,
): Array<{ index: number; bounds: { x: number; y: number; width: number; height: number }; label: null }>;
export function unionClip(
  boxes?: Array<{ x?: number; y?: number; width?: number; height?: number }>,
  options?: {
    pad?: number;
    promptPad?: number;
    viewport?: { width?: number; height?: number } | null;
  },
): { x: number; y: number; width: number; height: number } | null;
export function visionGridInstruction(options?: {
  prompt?: string;
  grid?: { rows?: number; cols?: number };
  tileCount?: number;
}): string;
export function extractDarkBlobs(
  image?: { width?: number; height?: number; data?: ArrayLike<number> },
  options?: {
    maxLuma?: number;
    minCount?: number;
    maxCount?: number;
    topInset?: number;
    bottomInset?: number;
  },
): Array<{
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
  cx: number;
  cy: number;
}>;
type DarkBlobList = ReadonlyArray<{
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
  cx: number;
  cy: number;
}>;

export function pickGrowingBlob(
  first?: DarkBlobList,
  second?: DarkBlobList,
  options?: { minGrown?: number; minRatio?: number },
): {
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
  cx: number;
  cy: number;
  grown: number;
  ratio: number;
  score: number;
  matched: boolean;
  confidence: number;
} | null;
export function findGrowingRegion(
  firstImage?: { width?: number; height?: number; data?: ArrayLike<number> },
  secondImage?: { width?: number; height?: number; data?: ArrayLike<number> },
  options?: {
    maxLuma?: number;
    minCount?: number;
    maxCount?: number;
    topInset?: number;
    bottomInset?: number;
    minGrown?: number;
    minRatio?: number;
  },
): ReturnType<typeof pickGrowingBlob>;
export function pickDragFitPair(
  blobs?: DarkBlobList,
  options?: { minSide?: number },
): {
  piece: { cx: number; cy: number; width: number; height: number; count: number; density: number };
  hole: { cx: number; cy: number; width: number; height: number; count: number; density: number };
  score: number;
} | null;
export function blobToPageBounds(
  blob: { cx?: number; cy?: number; width?: number; height?: number },
  image: { width?: number; height?: number },
  cssBox: { x?: number; y?: number; width?: number; height?: number },
  pad?: number,
): { x: number; y: number; width: number; height: number; cx: number; cy: number };
