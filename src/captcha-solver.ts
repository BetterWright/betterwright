// Local, self-hosted CAPTCHA solving for BetterWright.
//
// Solves challenges inside the existing browser session with human-shaped
// pointer motion. No third-party captcha APIs, no token farms, no heavy ML
// runtimes — just DOM/frame inspection, clicks, drags, waits, and vision
// handoff when an image or text stage needs the host model.
//
// Result envelope mirrors the 2Captcha mental model (create → poll status)
// while remaining fully in-process:
//   status "ready"       → challenge cleared (token present or widget gone)
//   status "processing"  → needs another stage or vision handoff
//   status "error"       → rejected, timed out, or unsupported

import {
  hostIs,
  isGoogleHost,
  isRecord,
  normalizedText,
  parsedUrl,
  stringValue,
} from "./untrusted-value.js";

export const CAPTCHA_SOLVE_STATUSES = Object.freeze({
  READY: "ready",
  PROCESSING: "processing",
  ERROR: "error",
});

export const CAPTCHA_STAGES = Object.freeze({
  NONE: "none",
  CHECKBOX: "checkbox",
  TURNSTILE: "turnstile",
  MANAGED: "managed_challenge",
  IMAGE_GRID: "image_grid",
  MOTION: "motion",
  SLIDER: "slider",
  TEXT: "text",
  INVISIBLE: "invisible",
  UNKNOWN: "unknown",
});

export const CAPTCHA_PROVIDERS = Object.freeze([
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "cloudflare",
  "bing",
  "google",
  "generic",
]);

const IMAGE_GRID_TEXT =
  /(?:please )?(?:click|select|choose|tap) (?:all|each|every|the) (?:image|images|square|squares|tile|tiles)\b|select all images|which of these|pick each image|contains a \w+/i;

const MOTION_TEXT =
  /(?:shape|object|item) that (?:grows|moves|animates|changes|shrinks)|click on the (?:moving|growing) (?:shape|object|item)|please click on the shape/i;

const SLIDER_TEXT =
  /(?:slide|drag|swipe|move).{0,60}(?:slider|puzzle|piece|handle|arrow|element|shape)|drag the (?:element|piece|shape|object)|complete the (?:puzzle|slider)/i;

const TEXT_CAPTCHA_TEXT =
  /(?:type|enter|fill).{0,30}(?:characters|code|text|letters|numbers)|what (?:code|text|characters)/i;

const CHECKBOX_TEXT =
  /i(?:'|’)?m not a robot|verify you are human|confirm you are (?:a )?human|i am human/i;

const MANAGED_TEXT =
  /checking your browser|just a moment|performing security verification|enable javascript and cookies|ddos protection by cloudflare|attention required/i;

function providerFromUrl(url) {
  const parsed = parsedUrl(url);
  const host = parsed?.hostname.toLowerCase() || "";
  if (!host) return "generic";
  if (hostIs(host, "hcaptcha.com")) return "hcaptcha";
  if (hostIs(host, "cloudflare.com")) {
    return parsed.pathname.toLowerCase().includes("turnstile") ? "turnstile" : "cloudflare";
  }
  if (isGoogleHost(host) || hostIs(host, "recaptcha.net")) {
    if (parsed.pathname.toLowerCase().includes("/recaptcha/")) return "recaptcha";
    return "google";
  }
  if (hostIs(host, "bing.com")) return "bing";
  return "generic";
}

/**
 * Classify the interactive stage of a detected challenge from metadata.
 * Pure function — safe for unit tests without a browser.
 */
export function classifyChallengeStage(metadata: any = {}) {
  const input = isRecord(metadata) ? metadata : {};
  const main = isRecord(input.main) ? input.main : input;
  const frames = Array.isArray(input.frames)
    ? input.frames.filter(isRecord)
    : Array.isArray(input.childFrames)
      ? input.childFrames.filter(isRecord)
      : [];
  // Prefer child frames first so host-page marketing copy (e.g. a solver demo
  // site listing slider/image captchas) cannot override a live provider widget.
  const sources = [
    ...frames.map((frame, index) => ({
      kind: "frame",
      index,
      url: stringValue(frame.url),
      title: stringValue(frame.title),
      text: stringValue(frame.text),
      visible: typeof frame.visible === "boolean" ? frame.visible : null,
    })),
    {
      kind: "main",
      // The main document has no frame index; null keeps this shape union-
      // compatible with the frame entries above so callers can read `.index`
      // off either without narrowing.
      index: null,
      url: stringValue(main.url ?? input.url),
      title: stringValue(main.title ?? input.title),
      text: stringValue(main.text ?? input.text),
      visible: true,
    },
  ];

  let provider = stringValue(input.provider) || "generic";
  let stage: string = CAPTCHA_STAGES.NONE;
  let signal = null;
  let source = sources[sources.length - 1];

  for (const candidate of sources) {
    // Sites preload dormant CAPTCHA providers in hidden iframes. They are not
    // an interactive stage until the frame becomes visible or the host page
    // presents an explicit blocking prompt.
    if (candidate.kind === "frame" && candidate.visible === false) continue;
    const text = normalizedText(`${candidate.title}\n${candidate.text}`);
    const url = candidate.url.toLowerCase();
    const parsed = parsedUrl(candidate.url);
    const path = parsed?.pathname.toLowerCase() || "";
    const fromUrl = providerFromUrl(candidate.url);
    if (fromUrl !== "generic") provider = fromUrl;

    // Instruction copy beats a generic challenge-frame URL. hCaptcha serves
    // motion ("shape that grows") and drag-to-fit puzzles from the same
    // `#frame=challenge` widget that also hosts 3×3 image grids.
    if (MOTION_TEXT.test(text)) {
      stage = CAPTCHA_STAGES.MOTION;
      signal = "motion";
      source = candidate;
      break;
    }

    if (IMAGE_GRID_TEXT.test(text)) {
      stage = CAPTCHA_STAGES.IMAGE_GRID;
      signal = "image_grid";
      source = candidate;
      break;
    }

    if (
      (stage === CAPTCHA_STAGES.NONE || stage === CAPTCHA_STAGES.UNKNOWN) &&
      (SLIDER_TEXT.test(text) || /slider|puzzle-captcha|geetest/i.test(text))
    ) {
      stage = CAPTCHA_STAGES.SLIDER;
      signal = "slider";
      source = candidate;
      if (candidate.kind === "frame") break;
      continue;
    }

    if (
      path.includes("/bframe") ||
      /[?&#]frame=challenge(?:[&#]|$)/.test(url) ||
      /\/hcaptcha-?challenge/.test(path)
    ) {
      stage = CAPTCHA_STAGES.IMAGE_GRID;
      signal = "image_grid";
      source = candidate;
      break;
    }

    if (
      path.includes("/cdn-cgi/challenge-platform/") &&
      !path.includes("/turnstile/")
    ) {
      stage = CAPTCHA_STAGES.MANAGED;
      signal = "cloudflare_managed";
      source = candidate;
      if (provider === "generic") provider = "cloudflare";
      // Keep scanning frames for an image-grid escalation; do not let main copy win.
      if (candidate.kind === "frame") continue;
      break;
    }

    if (MANAGED_TEXT.test(text) && stage === CAPTCHA_STAGES.NONE) {
      stage = CAPTCHA_STAGES.MANAGED;
      signal = "managed_text";
      source = candidate;
      if (fromUrl === "cloudflare" || fromUrl === "turnstile") provider = fromUrl;
      if (candidate.kind === "frame") continue;
      break;
    }

    if (
      path.includes("/turnstile/") ||
      hostIs(parsedUrl(candidate.url)?.hostname.toLowerCase() || "", "challenges.cloudflare.com")
    ) {
      if (
        stage === CAPTCHA_STAGES.NONE ||
        stage === CAPTCHA_STAGES.CHECKBOX ||
        stage === CAPTCHA_STAGES.UNKNOWN ||
        stage === CAPTCHA_STAGES.INVISIBLE
      ) {
        stage = CAPTCHA_STAGES.TURNSTILE;
        signal = "turnstile_widget";
        source = candidate;
        provider = "turnstile";
      }
      // Keep scanning frames for image-grid escalation only.
      continue;
    }

    if (
      stage === CAPTCHA_STAGES.NONE &&
      TEXT_CAPTCHA_TEXT.test(text) &&
      /captcha|challenge|security/i.test(text)
    ) {
      stage = CAPTCHA_STAGES.TEXT;
      signal = "text_challenge";
      source = candidate;
      if (candidate.kind === "frame") break;
      continue;
    }

    if (
      path.endsWith("/anchor") ||
      /[?&#]frame=checkbox(?:[&#]|$)/.test(url) ||
      CHECKBOX_TEXT.test(text)
    ) {
      if (stage === CAPTCHA_STAGES.NONE || stage === CAPTCHA_STAGES.UNKNOWN) {
        stage = CAPTCHA_STAGES.CHECKBOX;
        signal = "checkbox";
        source = candidate;
      }
      continue;
    }

    if (/(?:^|[?&#])size=invisible(?:[&#]|$)/.test(url) || url.includes("checkbox-invisible")) {
      if (stage === CAPTCHA_STAGES.NONE) {
        stage = CAPTCHA_STAGES.INVISIBLE;
        signal = "invisible_widget";
        source = candidate;
      }
    }
  }

  if (stage === CAPTCHA_STAGES.NONE && (input.provider || input.type === "bot_challenge")) {
    stage = CAPTCHA_STAGES.UNKNOWN;
    signal = "unclassified";
  }

  return {
    stage,
    provider,
    signal,
    source: {
      kind: source?.kind || "main",
      url: source?.url || "",
      index: source?.index ?? null,
    },
    autoSolvable:
      stage === CAPTCHA_STAGES.CHECKBOX ||
      stage === CAPTCHA_STAGES.TURNSTILE ||
      stage === CAPTCHA_STAGES.MANAGED ||
      stage === CAPTCHA_STAGES.SLIDER ||
      stage === CAPTCHA_STAGES.MOTION,
    needsVision:
      stage === CAPTCHA_STAGES.IMAGE_GRID ||
      stage === CAPTCHA_STAGES.TEXT,
  };
}

/** Frame URL patterns used to locate provider widgets in the live page. */
export const WIDGET_FRAME_PATTERNS = Object.freeze({
  recaptcha: /recaptcha(?:\.net|\/)|google\.com\/recaptcha/i,
  hcaptcha: /hcaptcha\.com/i,
  turnstile: /challenges\.cloudflare\.com|turnstile/i,
  cloudflare: /cdn-cgi\/challenge-platform/i,
});

/**
 * Selectors for checkbox / verify controls inside provider frames or main page.
 * Ordered from most specific to fallbacks.
 */
export const CHECKBOX_SELECTORS = Object.freeze([
  "#checkbox",
  ".recaptcha-checkbox-border",
  ".recaptcha-checkbox",
  "#recaptcha-anchor",
  "[role='checkbox']",
  "input[type='checkbox']",
  ".mark",
  "#cf-stage",
  "label.cb-lb",
  ".cb-lb",
  "input[type='checkbox'] + span",
  "body",
]);

export const VERIFY_BUTTON_SELECTORS = Object.freeze([
  "#recaptcha-verify-button",
  ".button-submit",
  "button:has-text('Next')",
  "[role='button']:has-text('Next')",
  "button:has-text('Verify')",
  "button:has-text('Submit')",
  "button:has-text('Continue')",
  "button:has-text('I am human')",
  "input[value*='Verify' i]",
  "button[type='submit']",
  "input[type='submit']",
  "[data-callback]",
]);

export const SLIDER_SELECTORS = Object.freeze([
  "[role='slider']",
  ".slider-handle",
  ".slide-button",
  ".geetest_slider_button",
  ".captcha-slider-button",
  ".slider",
  ".handle-handle",
  ".dragger",
  "[draggable='true']",
  ".draggable",
  "#slider",
]);

export const MOTION_CONFIRM_SELECTORS = Object.freeze([
  ":text-is('Next')",
  ":text-is('Verify')",
  "button:has-text('Next')",
  "button:has-text('Verify')",
  "[role='button']:has-text('Next')",
  "[role='button']:has-text('Verify')",
]);

export const IMAGE_TILE_SELECTORS = Object.freeze([
  "td.rc-imageselect-tile",
  ".rc-imageselect-tile",
  ".rc-image-tile-wrapper",
  ".task-image",
  "[class*='task-image']",
  ".task",
  ".image-wrapper",
  "[role='button'][aria-label]",
  ".challenge-image",
  "div[class*='tile']",
  "div[class*='image'] button",
]);

export const CHALLENGE_WIDGET_SELECTORS = Object.freeze([
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="recaptcha" i]',
  'iframe[src*="bframe" i]',
  'iframe[title*="challenge" i]',
  'iframe[title*="hcaptcha" i]',
  'iframe[title*="captcha" i]',
  "[data-hcaptcha-widget-id]",
  "[data-bw-captcha]",
  "#bw-captcha",
  ".bw-captcha",
]);

export const CHALLENGE_INSTRUCTION_SELECTORS = Object.freeze([
  ".rc-imageselect-desc-wrapper",
  ".rc-imageselect-desc-no-canonical",
  ".rc-imageselect-instructions",
  ".prompt-text",
  ".challenge-text",
  "[class*='prompt-text']",
  "h2",
  "h1",
]);

const TILE_INDEX_MAX = 63;

/**
 * Normalize host-vision tile picks (`[0, 3, 5]`, `"0,3,5"`, or `{index}`).
 */
export function parseTileIndexes(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const indexes = [];
  const seen = new Set();
  for (const item of raw) {
    const n =
      item && typeof item === "object" && !Array.isArray(item)
        ? Number(item.index)
        : Number(item);
    if (!Number.isInteger(n) || n < 0 || n > TILE_INDEX_MAX || seen.has(n)) {
      continue;
    }
    seen.add(n);
    indexes.push(n);
  }
  return indexes;
}

function roundedBox(box) {
  return {
    x: Math.round(Number(box?.x) || 0),
    y: Math.round(Number(box?.y) || 0),
    width: Math.round(Number(box?.width) || 0),
    height: Math.round(Number(box?.height) || 0),
  };
}

function boxKey(box, quantum = 4) {
  const x = Math.round(box.x / quantum) * quantum;
  const y = Math.round(box.y / quantum) * quantum;
  return `${x},${y}`;
}

export function dedupeBoxes(boxes, quantum = 4) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(boxes) ? boxes : []) {
    const box = roundedBox(raw);
    if (box.width < 8 || box.height < 8) continue;
    const key = boxKey(box, quantum);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(box);
  }
  return out;
}

/** Left-to-right, top-to-bottom — the order overlaid numbers use. */
export function sortTilesReadingOrder(boxes, yTolerance = 12) {
  return [...(Array.isArray(boxes) ? boxes : [])].sort((a, b) => {
    if (Math.abs(a.y - b.y) > yTolerance) return a.y - b.y;
    return a.x - b.x;
  });
}

/**
 * Keep the largest cluster of similarly sized rectangles. Image-grid tiles
 * share a size; headers, prompts, and the widget chrome do not.
 */
export function clusterSimilarBoxes(boxes, { minCount = 3, sizeSlack = 14 }: any = {}) {
  const usable = dedupeBoxes(boxes).filter(
    (box) =>
      box.width >= 24 &&
      box.height >= 24 &&
      box.width <= 480 &&
      box.height <= 480,
  );
  let best = [];
  for (const seed of usable) {
    const group = usable.filter(
      (box) =>
        Math.abs(box.width - seed.width) <= sizeSlack &&
        Math.abs(box.height - seed.height) <= sizeSlack,
    );
    if (group.length > best.length) best = group;
  }
  if (best.length < minCount) return [];
  return sortTilesReadingOrder(best);
}

const CHROME_LABEL =
  /skip challenge|refresh challenge|select a language|accessibility|hcaptcha logo|recaptcha logo|privacy policy|terms of service|about hcaptcha|opens new window|^skip$|^en$|^english\b|^menu\b|^about\b|^refresh$|^reload$/i;

/** Footer/language/skip controls that look like tiles but are widget chrome. */
export function isCaptchaChromeLabel(label) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  return Boolean(text) && CHROME_LABEL.test(text);
}

/**
 * True for a real image-grid cluster (3×3 photos, 1×3 large images), false
 * for a row of tiny toolbar buttons.
 */
export function isPlausibleImageGrid(boxes, { minTiles = 3, minSide = 48 }: any = {}) {
  const list = (Array.isArray(boxes) ? boxes : []).map((entry) =>
    entry?.bounds && typeof entry.bounds === "object" ? entry.bounds : entry,
  );
  if (list.length < minTiles) return false;
  const sides = list.map((box) =>
    Math.min(Number(box?.width) || 0, Number(box?.height) || 0),
  );
  const largeEnough = sides.filter((side) => side >= minSide).length;
  if (largeEnough < minTiles) return false;
  if (list.length >= 6) return true;
  const grid = gridFromTiles(list);
  if (grid.rows === 1 && grid.cols >= 3 && Math.max(...sides) < 72) return false;
  return true;
}

/**
 * Prefer the cluster that looks most like a photo grid: more cells, then
 * larger cells. Chrome toolbars lose to a 3×3 of 100px tiles.
 */
export function pickBestTileSet(sets) {
  let best = [];
  let bestScore = 0;
  for (const set of Array.isArray(sets) ? sets : []) {
    if (!Array.isArray(set) || !set.length) continue;
    const boxes = set.map((tile) =>
      tile?.bounds && typeof tile.bounds === "object" ? tile.bounds : tile,
    );
    if (!isPlausibleImageGrid(boxes)) continue;
    const area =
      boxes.reduce(
        (sum, box) => sum + (Number(box?.width) || 0) * (Number(box?.height) || 0),
        0,
      ) / boxes.length;
    const score = set.length * 10_000 + area;
    if (score <= bestScore) continue;
    bestScore = score;
    best = set.map((tile, index) => {
      const bounds = roundedBox(
        tile?.bounds && typeof tile.bounds === "object" ? tile.bounds : tile,
      );
      return {
        index: Number.isInteger(tile?.index) ? tile.index : index,
        bounds,
        label: tile?.label || null,
      };
    });
  }
  return best.map((tile, index) => ({ ...tile, index }));
}

export function publicCaptchaTiles(tiles) {
  if (!Array.isArray(tiles) || !tiles.length) return null;
  return tiles.map((tile, index) => {
    const bounds = roundedBox(
      tile?.bounds && typeof tile.bounds === "object" ? tile.bounds : tile,
    );
    return {
      index: Number.isInteger(tile?.index) ? tile.index : index,
      bounds,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      label: tile?.label || null,
    };
  });
}

export function gridFromTiles(tiles) {
  const list = Array.isArray(tiles) ? tiles : [];
  if (!list.length) return { rows: 0, cols: 0 };
  const yTol = 12;
  const xTol = 12;
  const rows = [];
  const cols = [];
  for (const tile of list) {
    const bounds = tile?.bounds && typeof tile.bounds === "object" ? tile.bounds : tile;
    const y = Number(bounds?.y);
    const x = Number(bounds?.x);
    if (Number.isFinite(y) && !rows.some((row) => Math.abs(row - y) <= yTol)) {
      rows.push(y);
    }
    if (Number.isFinite(x) && !cols.some((col) => Math.abs(col - x) <= xTol)) {
      cols.push(x);
    }
  }
  return { rows: rows.length, cols: cols.length };
}

export function inferGridTiles(box, cols = 3, rows = 3) {
  const bounds = roundedBox(box);
  const columnCount = Math.max(2, Math.min(5, Math.floor(Number(cols) || 3)));
  const rowCount = Math.max(2, Math.min(5, Math.floor(Number(rows) || 3)));
  if (bounds.width < 40 || bounds.height < 40) return [];
  const cellWidth = bounds.width / columnCount;
  const cellHeight = bounds.height / rowCount;
  const tiles = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < columnCount; col += 1) {
      tiles.push({
        index: row * columnCount + col,
        bounds: {
          x: Math.round(bounds.x + col * cellWidth),
          y: Math.round(bounds.y + row * cellHeight),
          width: Math.round(cellWidth),
          height: Math.round(cellHeight),
        },
        label: null,
      });
    }
  }
  return tiles;
}

/**
 * Tight screenshot clip covering tiles plus a strip above for the prompt.
 * Clamped to the viewport when one is supplied.
 */
export function unionClip(boxes, { pad = 12, promptPad = 72, viewport = null }: any = {}) {
  const list = dedupeBoxes(boxes);
  if (!list.length) return null;
  let x = Math.min(...list.map((box) => box.x));
  let y = Math.min(...list.map((box) => box.y));
  let right = Math.max(...list.map((box) => box.x + box.width));
  let bottom = Math.max(...list.map((box) => box.y + box.height));
  x = Math.max(0, Math.floor(x - pad));
  y = Math.max(0, Math.floor(y - pad - promptPad));
  right = Math.ceil(right + pad);
  bottom = Math.ceil(bottom + pad);
  const view = viewport && typeof viewport === "object" ? viewport : null;
  const viewWidth = Number(view?.width);
  const viewHeight = Number(view?.height);
  if (Number.isFinite(viewWidth) && viewWidth > 0) {
    x = Math.min(x, Math.max(0, viewWidth - 1));
    right = Math.min(right, viewWidth);
  }
  if (Number.isFinite(viewHeight) && viewHeight > 0) {
    y = Math.min(y, Math.max(0, viewHeight - 1));
    bottom = Math.min(bottom, viewHeight);
  }
  const width = Math.max(1, right - x);
  const height = Math.max(1, bottom - y);
  return { x, y, width, height };
}

export function visionGridInstruction({ prompt, grid, tileCount }: any = {}) {
  const rows = Number(grid?.rows) || 0;
  const cols = Number(grid?.cols) || 0;
  const shape = rows && cols ? `${rows}×${cols}` : `${Number(tileCount) || 0}-tile`;
  const task = String(prompt || "").replace(/\s+/g, " ").trim();
  const match = task
    ? `Pick every numbered tile that matches: ${task}`
    : "Pick every numbered tile that matches the on-screen prompt";
  return (
    `${match}. Numbers are overlaid on the attached ${shape} crop. ` +
    "Then call captcha.solve({ tiles: [indexes] }) — do not click bounds by hand."
  );
}

/**
 * Build a 2Captcha-style solve result envelope.
 */
export function buildSolveResult({
  status,
  provider = "generic",
  stage = CAPTCHA_STAGES.UNKNOWN,
  requestId = null,
  token = null,
  errorCode = null,
  errorText = null,
  attempts = [],
  artifact = null,
  tiles = null,
  instruction = null,
  cleared = false,
  challenge = null,
  grid = null,
}: any = {}): any {
  const id =
    requestId ||
    `bw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    // 2Captcha-compatible field names where they map cleanly.
    status,
    request: id,
    requestId: id,
    // BetterWright extensions.
    provider,
    stage,
    cleared: Boolean(cleared || status === CAPTCHA_SOLVE_STATUSES.READY),
    token: token || null,
    errorCode: errorCode || null,
    errorText: errorText || null,
    attempts: Array.isArray(attempts) ? attempts : [],
    artifact: artifact || null,
    tiles: publicCaptchaTiles(tiles),
    grid: grid || null,
    instruction: instruction || null,
    challenge: challenge || null,
    local: true,
    externalApi: false,
  };
}

/**
 * Dark connected components in an RGBA buffer. Used to find stars / pieces
 * on motion and drag-to-fit canvases without a third-party ML runtime.
 */
export function extractDarkBlobs(image, options: any = {}) {
  const width = Math.floor(Number(image?.width) || 0);
  const height = Math.floor(Number(image?.height) || 0);
  const data = image?.data;
  if (width < 8 || height < 8 || !data || data.length < width * height * 4) {
    return [];
  }
  const maxLuma = Number.isFinite(Number(options.maxLuma))
    ? Number(options.maxLuma)
    : 110;
  const minCount = Number.isFinite(Number(options.minCount))
    ? Number(options.minCount)
    : 24;
  const maxCount = Number.isFinite(Number(options.maxCount))
    ? Number(options.maxCount)
    : 30_000;
  const topInset = Math.max(
    0,
    Math.floor(height * (Number(options.topInset) || 0)),
  );
  const bottomInset = Math.max(
    0,
    Math.floor(height * (Number(options.bottomInset) || 0)),
  );
  const y0 = Math.min(height - 1, topInset);
  const y1 = Math.max(y0 + 1, height - bottomInset);
  const visited = new Uint8Array(width * height);
  const blobs = [];
  const lumaAt = (index) => {
    const o = index * 4;
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  };
  const isDark = (index) =>
    data[index * 4 + 3] >= 128 && lumaAt(index) <= maxLuma;

  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (visited[start] || !isDark(start)) continue;
      let minx = x;
      let miny = y;
      let maxx = x;
      let maxy = y;
      let count = 0;
      let sx = 0;
      let sy = 0;
      const stack = [start];
      visited[start] = 1;
      while (stack.length) {
        const p = stack.pop();
        const px = p % width;
        const py = (p / width) | 0;
        count += 1;
        sx += px;
        sy += py;
        if (px < minx) minx = px;
        if (py < miny) miny = py;
        if (px > maxx) maxx = px;
        if (py > maxy) maxy = py;
        const neighbors = [];
        if (px > 0) neighbors.push(p - 1);
        if (px + 1 < width) neighbors.push(p + 1);
        if (py > 0) neighbors.push(p - width);
        if (py + 1 < height) neighbors.push(p + width);
        for (const n of neighbors) {
          if (visited[n]) continue;
          const ny = (n / width) | 0;
          if (ny < y0 || ny >= y1) continue;
          if (!isDark(n)) continue;
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (count < minCount || count > maxCount) continue;
      const bw = maxx - minx + 1;
      const bh = maxy - miny + 1;
      if (bw > width * 0.92 && bh < height * 0.22) continue;
      blobs.push({
        x: minx,
        y: miny,
        width: bw,
        height: bh,
        count,
        cx: sx / count,
        cy: sy / count,
      });
    }
  }
  return blobs;
}

/**
 * Pair blobs across two frames and pick the one whose dark area grew.
 */
export function pickGrowingBlob(first, second, options: any = {}) {
  const earlier = Array.isArray(first) ? first : [];
  const later = Array.isArray(second) ? second : [];
  const minGrown = Number.isFinite(Number(options.minGrown))
    ? Number(options.minGrown)
    : 18;
  const minRatio = Number.isFinite(Number(options.minRatio))
    ? Number(options.minRatio)
    : 1.12;
  let best = null;
  let secondScore = 0;
  for (const blob of later) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const prev of earlier) {
      const d = Math.hypot(blob.cx - prev.cx, blob.cy - prev.cy);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = prev;
      }
    }
    const matchRadius = Math.max(28, Math.max(blob.width, blob.height) * 1.4);
    const matched = Boolean(nearest && nearestDist <= matchRadius);
    const prevCount = matched
      ? nearest.count
      : Math.max(1, Math.round(blob.count * 0.45));
    const grown = blob.count - prevCount;
    const ratio = blob.count / prevCount;
    if (grown < minGrown || ratio < minRatio) continue;
    const score = grown * ratio;
    if (!best || score > best.score) {
      secondScore = best ? best.score : 0;
      best = { ...blob, grown, ratio, score, matched };
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (!best) return null;
  const confidence =
    secondScore > 0 ? Math.min(1, 1 - secondScore / best.score) : 0.92;
  if (best.score < 28 && confidence < 0.2) return null;
  return { ...best, confidence };
}

export function findGrowingShape(firstImage, secondImage, options: any = {}) {
  return pickGrowingBlob(
    extractDarkBlobs(firstImage, options),
    extractDarkBlobs(secondImage, options),
    options,
  );
}

/**
 * Drag-to-fit: a filled piece (high density) and a hollow slot (low density)
 * of similar size, far enough apart to drag between.
 */
export function pickDragFitPair(blobs, options: any = {}) {
  const minSide = Number.isFinite(Number(options.minSide))
    ? Number(options.minSide)
    : 14;
  const list = (Array.isArray(blobs) ? blobs : [])
    .map((blob) => ({
      ...blob,
      area: Math.max(1, blob.width * blob.height),
      density: blob.count / Math.max(1, blob.width * blob.height),
    }))
    .filter((blob) => blob.width >= minSide && blob.height >= minSide);
  if (list.length < 2) return null;
  let best = null;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const sizeRatio =
        Math.max(a.width, b.width) / Math.max(1, Math.min(a.width, b.width));
      if (sizeRatio > 2.8) continue;
      const dist = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (dist < 28) continue;
      const piece = a.density >= b.density ? a : b;
      const hole = piece === a ? b : a;
      if (piece.density - hole.density < 0.08) continue;
      const score = (piece.density - hole.density) * dist;
      if (!best || score > best.score) best = { piece, hole, score };
    }
  }
  return best;
}

export function blobToPageBounds(blob, image, cssBox, pad = 10) {
  const width = Math.max(1, Number(image?.width) || 1);
  const height = Math.max(1, Number(image?.height) || 1);
  const sx = Number(cssBox?.width) / width;
  const sy = Number(cssBox?.height) / height;
  const cx = Number(cssBox?.x) + Number(blob?.cx) * sx;
  const cy = Number(cssBox?.y) + Number(blob?.cy) * sy;
  const w = Math.max(28, Number(blob?.width) * sx + pad * 2);
  const h = Math.max(28, Number(blob?.height) * sy + pad * 2);
  return {
    x: cx - w / 2,
    y: cy - h / 2,
    width: w,
    height: h,
    cx,
    cy,
  };
}

/**
 * Decide the next auto-solve action from a classified stage.
 * Pure strategy table — the worker executes the returned action.
 */
export function nextSolveAction(classification, attemptIndex = 0) {
  const stage = classification?.stage || CAPTCHA_STAGES.UNKNOWN;
  switch (stage) {
    case CAPTCHA_STAGES.CHECKBOX:
      return {
        action: "click_checkbox",
        waitMs: 2_500,
        description: "Click the provider checkbox with human-shaped motion",
      };
    case CAPTCHA_STAGES.TURNSTILE:
      return {
        action: attemptIndex === 0 ? "click_checkbox" : "wait_token",
        waitMs: attemptIndex === 0 ? 3_000 : 5_000,
        description:
          attemptIndex === 0
            ? "Click the Turnstile widget"
            : "Wait for Turnstile to issue a response token",
      };
    case CAPTCHA_STAGES.MANAGED:
      return {
        action: attemptIndex === 0 ? "click_verify" : "wait_clear",
        waitMs: 5_000,
        description:
          attemptIndex === 0
            ? "Click the managed-challenge verify control if present"
            : "Wait for the managed browser check to clear",
      };
    case CAPTCHA_STAGES.SLIDER:
      return {
        action: "drag_slider",
        waitMs: 2_000,
        description: "Drag the slider/puzzle handle",
      };
    case CAPTCHA_STAGES.IMAGE_GRID:
      return {
        action: "capture_tiles",
        waitMs: 0,
        description:
          "Crop the puzzle, overlay tile numbers, and hand the image to host vision",
      };
    case CAPTCHA_STAGES.MOTION:
      return {
        action: "click_growing",
        waitMs: 1_800,
        description:
          "Sample two animation frames, click the shape that grew, then confirm Next",
      };
    case CAPTCHA_STAGES.TEXT:
      return {
        action: "capture_text",
        waitMs: 0,
        description: "Capture the text CAPTCHA crop for host vision/OCR",
      };
    case CAPTCHA_STAGES.INVISIBLE:
      return {
        action: "wait_token",
        waitMs: 4_000,
        description: "Wait for the invisible widget to mint a token",
      };
    default:
      return {
        action: "inspect",
        waitMs: 0,
        description: "Inspect the challenge visually; no automatic action available",
      };
  }
}

export function maxAutoStages(options: any = {}) {
  const raw = Number(options?.maxStages ?? options?.maxAttempts ?? 5);
  if (!Number.isFinite(raw)) return 5;
  return Math.max(1, Math.min(8, Math.floor(raw)));
}

export function solveTimeoutMs(options: any = {}) {
  const raw = Number(options?.timeout ?? options?.timeoutMs ?? 45_000);
  if (!Number.isFinite(raw)) return 45_000;
  return Math.max(3_000, Math.min(180_000, Math.floor(raw)));
}
