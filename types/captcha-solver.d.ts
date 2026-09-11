import type { UntrustedValue } from "./untrusted-value.js";

// The local solver's shared primitives: stage classification, tile-grid
// geometry, frame-diff blob analysis, and the solve-result envelope. The
// worker's `captcha.*` sandbox helpers are built on these. Exported for hosts
// and tests; most consumers only need the helpers in docs/captcha.md.

/** Solve outcome strings for `CaptchaSolveResult.status`. */
export const CAPTCHA_SOLVE_STATUSES: Readonly<{
  READY: "ready";
  PROCESSING: "processing";
  ERROR: "error";
}>;

/** Challenge stages the classifier can return. */
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

/** Provider names the classifier recognizes. */
export const CAPTCHA_PROVIDERS: readonly string[];

/** What `classifyChallengeStage` decided about a page's challenge state. */
export interface ChallengeStageClassification {
  /** One of `CAPTCHA_STAGES`. */
  stage: string;
  /** The recognized provider name, or a best-effort label. */
  provider: string;
  /** The detail that drove the classification, when one exists. */
  signal: string | null;
  /** Where the deciding evidence came from: a child frame or the main document. */
  source: {
    kind: string;
    url: string;
    index: number | null;
  };
  /** The stage can be attempted without host vision. */
  autoSolvable: boolean;
  /** The stage needs a vision model (image grids, text puzzles). */
  needsVision: boolean;
}

/** The `captcha.solve()` result envelope. */
export interface CaptchaSolveResult {
  status: "ready" | "processing" | "error" | string;
  /** What was asked for: "detect" or "solve". */
  request: string;
  requestId: string;
  provider: string;
  stage: string;
  /** The challenge is gone and the page is usable. */
  cleared: boolean;
  /** A response token when the widget minted one, else null. */
  token: string | null;
  errorCode: string | null;
  errorText: string | null;
  attempts: unknown[];
  /** Image artifact for the challenge crop, when one was captured. */
  artifact: unknown;
  tiles: unknown;
  grid: unknown;
  /** The instruction text a vision host should answer. */
  instruction: string | null;
  challenge: unknown;
  local: true;
  externalApi: false;
}

/** One automatic step `nextSolveAction` recommends for a stage. */
export interface SolveAction {
  action: string;
  /** How long the worker waits after performing it. */
  waitMs: number;
  description: string;
}

/**
 * Classify page metadata (frames, titles, URLs, visible text) into a stage and
 * provider. Child frames are checked before the main document so host-page
 * copy cannot override a live provider widget.
 */
export function classifyChallengeStage(metadata?: UntrustedValue): ChallengeStageClassification;
/** Fill a partial solve result out to the full envelope shape. */
export function buildSolveResult(input?: Partial<CaptchaSolveResult> & {
  status?: string;
  requestId?: string | null;
}): CaptchaSolveResult;
/** The next automatic action for a stage and attempt number. */
export function nextSolveAction(
  classification: { stage?: string } | null | undefined,
  attemptIndex?: number,
): SolveAction;
/** Automatic stages allowed per solve: clamped to 1..3, default 3. */
export function maxAutoStages(options?: { maxStages?: number; maxAttempts?: number }): number;
/** Solve wall-clock bound: clamped to 3..180 s, default 45 s. */
export function solveTimeoutMs(options?: { timeout?: number; timeoutMs?: number }): number;

/** Frame-URL patterns keyed by provider name. */
export const WIDGET_FRAME_PATTERNS: Readonly<Record<string, RegExp>>;
export const CHECKBOX_SELECTORS: readonly string[];
export const VERIFY_BUTTON_SELECTORS: readonly string[];
export const SLIDER_SELECTORS: readonly string[];
export const MOTION_CONFIRM_SELECTORS: readonly string[];
export const IMAGE_TILE_SELECTORS: readonly string[];
export const SELECTED_IMAGE_TILE_SELECTORS: readonly string[];
export const CHALLENGE_WIDGET_SELECTORS: readonly string[];
export const CHALLENGE_INSTRUCTION_SELECTORS: readonly string[];

/** Coerce untrusted input into sorted, unique tile indexes. */
export function parseTileIndexes(value?: UntrustedValue): number[];
/** Merge rectangles within `quantum` pixels of each other. */
export function dedupeBoxes(
  boxes?: Array<{ x?: number; y?: number; width?: number; height?: number }>,
  quantum?: number,
): Array<{ x: number; y: number; width: number; height: number }>;
/** Order rectangles top-to-bottom, left-to-right within a row. */
export function sortTilesReadingOrder(
  boxes?: Array<{ x?: number; y?: number; width?: number; height?: number }>,
  yTolerance?: number,
): Array<{ x: number; y: number; width: number; height: number }>;
/** Find groups of similar-sized boxes; how a tile grid is located. */
export function clusterSimilarBoxes(
  boxes?: Array<{ x?: number; y?: number; width?: number; height?: number }>,
  options?: { minCount?: number; sizeSlack?: number },
): Array<{ x: number; y: number; width: number; height: number }>;
/** Drop boxes contained inside larger ones. */
export function collapseNestedBoxes(
  boxes?: Array<{ x?: number; y?: number; width?: number; height?: number }>,
  options?: { overlap?: number; minAreaRatio?: number },
): Array<{ x: number; y: number; width: number; height: number }>;
/** Label belongs to the widget's chrome, not a control (reCAPTCHA logo links). */
export function isCaptchaChromeLabel(label?: UntrustedValue): boolean;
/** Label is a "skip"/"next" control that advances without solving. */
export function isCaptchaSkipSubmitLabel(label?: UntrustedValue): boolean;
/** Label is a verify/submit control. */
export function isCaptchaVerifySubmitLabel(label?: UntrustedValue): boolean;
/** The verify control exists and is enabled in the scanned state. */
export function isCaptchaVerifySubmitReady(state?: UntrustedValue): boolean;
/** Boxes plausibly form an image-grid puzzle (enough tiles, sensible size). */
export function isPlausibleImageGrid(
  boxes?: UntrustedValue,
  options?: { minTiles?: number; minSide?: number },
): boolean;
/** The best tile set among candidate grids: coverage, then regularity. */
export function pickBestTileSet(sets?: UntrustedValue): Array<{
  index: number;
  bounds: { x: number; y: number; width: number; height: number };
  label: string | null;
}>;
/** Sanitize internal tile records into the shape results expose. */
export function publicCaptchaTiles(tiles?: UntrustedValue): Array<{
  index: number;
  bounds: { x: number; y: number; width: number; height: number };
  x: number;
  y: number;
  width: number;
  height: number;
  label: string | null;
}> | null;
/** Derive row/column counts from a tile list's positions. */
export function gridFromTiles(tiles?: UntrustedValue): { rows: number; cols: number };
/** Synthesize `cols` x `rows` tile bounds inside a containing box. */
export function inferGridTiles(
  box: { x?: number; y?: number; width?: number; height?: number },
  cols?: number,
  rows?: number,
): Array<{ index: number; bounds: { x: number; y: number; width: number; height: number }; label: null }>;
/** Bounding box over boxes plus padding, clamped to the viewport. */
export function unionClip(
  boxes?: Array<{ x?: number; y?: number; width?: number; height?: number }>,
  options?: {
    pad?: number;
    promptPad?: number;
    viewport?: { width?: number; height?: number } | null;
  },
): { x: number; y: number; width: number; height: number } | null;
/** Build the "pick the numbered tiles that contain X" text for host vision. */
export function visionGridInstruction(options?: {
  prompt?: string;
  grid?: { rows?: number; cols?: number };
  tileCount?: number;
}): string;
/** Dark connected regions in raw RGBA image data; piece/shadow shapes. */
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

/** The blob that grew between two sampled frames; motion-challenge answer. */
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
/** `extractDarkBlobs` on two frames, then `pickGrowingBlob` on the pair. */
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
/** Pair the puzzle piece with the hole it fits for drag-to-fit challenges. */
export function pickDragFitPair(
  blobs?: DarkBlobList,
  options?: { minSide?: number },
): {
  piece: { cx: number; cy: number; width: number; height: number; count: number; density: number };
  hole: { cx: number; cy: number; width: number; height: number; count: number; density: number };
  score: number;
} | null;
/** Map a blob in image pixels to page CSS bounds inside a captured box. */
export function blobToPageBounds(
  blob: { cx?: number; cy?: number; width?: number; height?: number },
  image: { width?: number; height?: number },
  cssBox: { x?: number; y?: number; width?: number; height?: number },
  pad?: number,
): { x: number; y: number; width: number; height: number; cx: number; cy: number };
