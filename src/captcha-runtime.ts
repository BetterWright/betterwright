// Native CAPTCHA interactions. Browser ownership and artifact storage stay with
// the caller; only the screenshot operation is injected into the runtime.
import fs from "node:fs";
import type { Frame, Locator, Page, PageScreenshotOptions } from "playwright-core";
import {
  blobToPageBounds,
  buildSolveResult,
  CAPTCHA_SOLVE_STATUSES,
  CAPTCHA_STAGES,
  CHALLENGE_INSTRUCTION_SELECTORS,
  CHALLENGE_WIDGET_SELECTORS,
  CHECKBOX_SELECTORS,
  classifyChallengeStage,
  clusterSimilarBoxes,
  extractDarkBlobs,
  findGrowingRegion,
  gridFromTiles,
  IMAGE_TILE_SELECTORS,
  isCaptchaChromeLabel,
  isCaptchaSkipSubmitLabel,
  isCaptchaVerifySubmitReady,
  MOTION_CONFIRM_SELECTORS,
  maxAutoStages,
  nextSolveAction,
  parseTileIndexes,
  pickBestTileSet,
  pickDragFitPair,
  SELECTED_IMAGE_TILE_SELECTORS,
  SLIDER_SELECTORS,
  solveTimeoutMs,
  unionClip,
  VERIFY_BUTTON_SELECTORS,
  visionGridInstruction,
  WIDGET_FRAME_PATTERNS,
} from "./captcha-solver.js";
import {
  type CaptureChallengeScreenshot,
  type ChallengeSession,
  collectChallengeMetadata,
} from "./challenge-scan.js";
import { detectBotChallenge } from "./challenges.js";
import { movePointer, pointInside, pressPointer } from "./human.js";

export interface CaptchaSession extends Pick<ChallengeSession, "artifacts"> {
  cursor: { x: number; y: number; initialized: boolean };
  captchaTargets: Map<number, {
    bounds: { x: number; y: number; width: number; height: number };
    pageBounds?: { x: number; y: number; width: number; height: number };
    label: string | null;
  }>;
  captchaGrid: { url: string; signature: string } | null;
}

interface CaptchaRuntimeDeps<Session> {
  captureScreenshot: CaptureChallengeScreenshot<Session>;
}

export const CAPTCHA_SCREENSHOT_TIMEOUT_MS = 8_000;
// Local fixture widgets that render without a provider frame.
const LOCAL_WIDGET_SELECTOR = "[data-bw-captcha], #bw-captcha, .bw-captcha";
export const CAPTCHA_TILE_OVERLAY_ID = "__betterwright_captcha_tiles__";

export function captchaBounds(value, label = "bounds") {
  const bounds = {
    x: Number(value?.x),
    y: Number(value?.y),
    width: Number(value?.width),
    height: Number(value?.height),
  };
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error(
      `captcha ${label} requires finite x, y, width, and height values with positive dimensions.`,
    );
  }
  return bounds;
}

export function captchaPoint(value, label) {
  const point = { x: Number(value?.x), y: Number(value?.y) };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`captcha ${label} requires finite x and y values.`);
  }
  return point;
}

export function drawCaptchaTileOverlay({ tiles, overlayId }) {
  document.getElementById(overlayId)?.remove();
  const root = document.createElement("div");
  root.id = overlayId;
  root.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  for (const tile of tiles) {
    const box = tile.bounds;
    const frame = document.createElement("div");
    frame.style.cssText =
      `position:absolute;left:${box.x}px;top:${box.y}px;` +
      `width:${box.width}px;height:${box.height}px;` +
      "border:3px solid #facc15;box-sizing:border-box;" +
      "background:rgba(250,204,21,0.14);";
    const label = document.createElement("span");
    label.textContent = String(tile.index);
    const size = Math.max(
      16,
      Math.min(36, Math.floor(Math.min(box.width, box.height) * 0.34)),
    );
    label.style.cssText =
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);" +
      `background:#111;color:#facc15;font:${size}px/${size + 4}px ui-monospace,monospace;` +
      "font-weight:700;padding:1px 6px;border-radius:4px;border:2px solid #facc15;";
    frame.appendChild(label);
    root.appendChild(frame);
  }
  document.body.appendChild(root);
}

function removeAnnotationOverlay(overlayId) {
  document.getElementById(overlayId)?.remove();
}

function hostDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sampleCanvasRgbaInPage(canvas, maxWidth) {
  if (!canvas || canvas.width < 16 || canvas.height < 16) return null;
  const scale = Math.min(1, maxWidth / canvas.width);
  const width = Math.max(8, Math.round(canvas.width * scale));
  const height = Math.max(8, Math.round(canvas.height * scale));
  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = height;
  const ctx = copy.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(canvas, 0, 0, width, height);
  } catch {
    return null;
  }
  const img = ctx.getImageData(0, 0, width, height);
  let dark = 0;
  for (let i = 0; i < img.data.length; i += 16) {
    if (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2] < 110) {
      dark += 1;
    }
  }
  if (dark < 3) return null;
  return { width, height, data: Array.from(img.data) };
}

function frameMatchesProvider(frame: Frame, provider) {
  const url = frame.url() || "";
  if (provider && WIDGET_FRAME_PATTERNS[provider]) {
    return WIDGET_FRAME_PATTERNS[provider].test(url);
  }
  return Object.values(WIDGET_FRAME_PATTERNS).some((pattern) => pattern.test(url));
}

function candidateFrames(page: Page, provider) {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  const matched = frames.filter((frame) => frameMatchesProvider(frame, provider));
  return matched.length ? matched : frames.slice(0, 8);
}

/**
 * Page-coordinate box of a provider's challenge frame, taken from the frame
 * element itself. Turnstile mounts its iframe in a closed shadow root, where
 * neither `document.querySelector` nor a Playwright selector can see it, so
 * walking back from the attached frame is the only way to locate the widget.
 */
async function widgetFrameBox(page: Page, provider) {
  for (const frame of candidateFrames(page, provider)) {
    const element = await frame.frameElement().catch(() => null);
    if (!element) continue;
    try {
      const box = await element.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) return box;
    } finally {
      await element.dispose().catch(() => {});
    }
  }
  return null;
}

async function elementBoxInPage(_page: Page, _frame: Page | Frame, locator: Locator) {
  const handle = await locator.elementHandle({ timeout: 1_500 }).catch(() => null);
  if (!handle) return null;
  try {
    const box = await handle.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    // Frame-local boxes are already in page CSS pixels for Playwright frames.
    return box;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

async function findClickableInScopes(page: Page, scopes: (Page | Frame)[], selectors) {
  for (const scope of scopes) {
    for (const selector of selectors) {
      const locator = scope.locator(selector).first();
      const visible = await locator.isVisible({ timeout: 400 }).catch(() => false);
      if (!visible) continue;
      const box = await elementBoxInPage(page, scope, locator);
      if (box) return { locator, box, scope, selector };
    }
  }
  return null;
}

async function locatorAccessibleName(locator: Locator) {
  const parts = await Promise.all([
    locator.innerText().catch(() => ""),
    locator.getAttribute("aria-label").catch(() => ""),
    locator.getAttribute("title").catch(() => ""),
    locator.getAttribute("value").catch(() => ""),
  ]);
  return (
    parts
      .map((value) => String(value || "").replace(/\s+/g, " ").trim())
      .find(Boolean) || ""
  );
}

async function locatorLooksDisabled(locator: Locator) {
  const aria = await locator.getAttribute("aria-disabled").catch(() => null);
  if (aria === "true") return true;
  const className = await locator.getAttribute("class").catch(() => "");
  return /(?:^|\s)(?:disabled|rc-button-disabled)(?:\s|$)/i.test(String(className || ""));
}

async function scopeHasSelectedCaptchaTiles(scope: Page | Frame) {
  const locator = scope.locator(SELECTED_IMAGE_TILE_SELECTORS.join(", "));
  const count = await locator.count().catch(() => 0);
  if (!count) return false;
  for (let i = 0; i < Math.min(count, 8); i += 1) {
    const visible = await locator.nth(i).isVisible({ timeout: 200 }).catch(() => false);
    if (visible) return true;
  }
  return false;
}

async function anyScopeHasSelectedCaptchaTiles(scopes) {
  for (const scope of scopes) {
    if (await scopeHasSelectedCaptchaTiles(scope)) return true;
  }
  return false;
}

async function recaptchaVerifyButtonLabel(scopes) {
  for (const scope of scopes) {
    const locator = scope.locator("#recaptcha-verify-button").first();
    const visible = await locator.isVisible({ timeout: 400 }).catch(() => false);
    if (!visible) continue;
    return locatorAccessibleName(locator);
  }
  return "";
}

/**
 * Submit control for the current challenge. reCAPTCHA reuses
 * `#recaptcha-verify-button` for Skip (new puzzle) and Verify (submit).
 * Clicking it while it still says Skip abandons a correct tile selection.
 */
async function findVerifyControl(page: Page, scopes: (Page | Frame)[], options: any = {}) {
  const previousLabel = String(options.previousLabel || "");
  for (const scope of scopes) {
    for (const selector of VERIFY_BUTTON_SELECTORS) {
      if (selector === "body") continue;
      const locator = scope.locator(selector).first();
      const visible = await locator.isVisible({ timeout: 400 }).catch(() => false);
      if (!visible) continue;
      const label = await locatorAccessibleName(locator);
      if (isCaptchaSkipSubmitLabel(label)) continue;
      if (await locatorLooksDisabled(locator)) continue;
      if (selector === "#recaptcha-verify-button") {
        if (
          !isCaptchaVerifySubmitReady({
            label,
            previousLabel,
            hadSelection: options.hadSelection,
          })
        ) {
          continue;
        }
      }
      const box = await elementBoxInPage(page, scope, locator);
      if (box) return { locator, box, scope, selector, label };
    }
  }
  return null;
}

async function waitForVerifyControl(page: Page, scopes: (Page | Frame)[], timeoutMs = 2_500, options: any = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findVerifyControl(page, scopes, options);
    if (found) return found;
    await hostDelay(120);
  }
  return null;
}

async function humanClickBox(page: Page, session: CaptchaSession, box, options: any = {}) {
  const inputLike = Boolean(options.inputLike);
  const leftBias = options.leftBias !== false;
  const point = leftBias
    ? {
        x: Math.round(box.x + box.width * (0.12 + Math.random() * 0.08)),
        y: Math.round(box.y + box.height * (0.4 + Math.random() * 0.2)),
      }
    : pointInside(box, inputLike);
  await movePointer(page.mouse, session.cursor, point, { stepDivisor: 8 });
  await pressPointer(page.mouse, inputLike);
  return point;
}

// Verify and checkbox controls come from boundingBox() in viewport
// coordinates, which may sit below the fold. Scroll them in first so the
// trusted pointer lands on the control instead of empty space.
async function humanClickControl(page: Page, session: CaptchaSession, box, options: any = {}) {
  const visible = await captchaBoxInViewport(page, box);
  return humanClickBox(page, session, visible, options);
}

async function pageScrollMetrics(page: Page) {
  return page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
  }));
}

/**
 * Turn a captured page-coordinate CAPTCHA box into current viewport
 * coordinates, scrolling only when its center is outside the clickable
 * viewport. Playwright can report a bounding box below the fold, while
 * page.mouse uses viewport coordinates and otherwise clicks empty space.
 */
export async function captchaBoxInViewport(page: Page, box, pageCoordinates = false) {
  const before = await pageScrollMetrics(page);
  const absolute = pageCoordinates
    ? box
    : { ...box, x: box.x + before.x, y: box.y + before.y };
  const center = {
    x: absolute.x + absolute.width / 2,
    y: absolute.y + absolute.height / 2,
  };
  const currentCenter = { x: center.x - before.x, y: center.y - before.y };
  const margin = 8;
  let left = before.x;
  let top = before.y;
  if (currentCenter.x < margin || currentCenter.x > before.width - margin) {
    left = Math.max(0, center.x - before.width / 2);
  }
  if (currentCenter.y < margin || currentCenter.y > before.height - margin) {
    top = Math.max(0, center.y - before.height / 2);
  }
  if (left !== before.x || top !== before.y) {
    await page.evaluate(({ left: x, top: y }) => window.scrollTo(x, y), { left, top });
  }
  const after = await pageScrollMetrics(page);
  return {
    x: absolute.x - after.x,
    y: absolute.y - after.y,
    width: absolute.width,
    height: absolute.height,
  };
}

async function challengeStillPresent(page: Page, provider) {
  const metadata = await collectChallengeMetadata(page);
  if (provider && metadata.tokens[provider]) return { present: false, metadata };
  if (Object.keys(metadata.tokens).length) return { present: false, metadata };
  const challenge = detectBotChallenge(metadata);
  // Generic widgets need not carry the interstitial text the detector matches.
  // Any visible challenge widget without a token is still unresolved after a
  // click. Dormant provider frames are hidden, so filter on visibility rather
  // than testing the first match.
  const widgetVisible = provider === "generic"
    ? await page
      .locator(CHALLENGE_WIDGET_SELECTORS.join(", "))
      .filter({ visible: true })
      .count()
      .then((count) => count > 0)
      .catch(() => false)
    : false;
  return { present: Boolean(challenge) || widgetVisible, metadata, challenge };
}

/**
 * Widget container box for clicking. `challengeWidgetBox` exists to crop
 * screenshots and so demands a puzzle-sized box; a checkbox widget is a wide,
 * short strip that the size gate rejects. Clicking only needs a real target.
 */
async function challengeWidgetClickBox(page: Page, provider) {
  const scopes = [page, ...candidateFrames(page, provider)];
  for (const scope of scopes) {
    const widget = scope.locator(CHALLENGE_WIDGET_SELECTORS.join(", ")).first();
    const visible = await widget.isVisible({ timeout: 400 }).catch(() => false);
    if (!visible) continue;
    const box = await elementBoxInPage(page, scope, widget);
    if (box && box.width >= 24 && box.height >= 16) return box;
  }
  return null;
}

async function challengeWidgetBox(page: Page, provider) {
  // Prefer the puzzle iframe. `.first()` on the combined selector is the
  // hCaptcha checkbox (too short), so a size-gated first() skipped the crop
  // and inspect fell back to a full-page screenshot.
  const preferred = page.locator(
    'iframe[src*="frame=challenge" i], iframe[src*="bframe" i]',
  ).first();
  const preferredBox = await preferred.boundingBox({ timeout: 800 }).catch(() => null);
  if (preferredBox && preferredBox.width >= 80 && preferredBox.height >= 80) {
    return preferredBox;
  }
  const loc = page.locator(CHALLENGE_WIDGET_SELECTORS.join(", "));
  const n = await loc.count().catch(() => 0);
  let best = null;
  for (let i = 0; i < Math.min(n, 8); i += 1) {
    const box = await loc.nth(i).boundingBox({ timeout: 400 }).catch(() => null);
    if (!box || box.width < 80 || box.height < 80) continue;
    if (!best || box.width * box.height > best.width * best.height) best = box;
  }
  if (best) return best;
  const scopes = [page, ...candidateFrames(page, provider)];
  for (const scope of scopes) {
    const local = scope.locator(LOCAL_WIDGET_SELECTOR).first();
    const localBox = await elementBoxInPage(page, scope, local);
    if (localBox && localBox.width >= 80 && localBox.height >= 80) return localBox;
  }
  return null;
}

async function readChallengeInstruction(page: Page, provider) {
  const scopes = [page, ...candidateFrames(page, provider)];
  for (const scope of scopes) {
    for (const selector of CHALLENGE_INSTRUCTION_SELECTORS) {
      const locator = scope.locator(selector).first();
      const visible = await locator.isVisible({ timeout: 250 }).catch(() => false);
      if (!visible) continue;
      const text = String(await locator.innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();
      if (text.length >= 8 && text.length < 240) return text;
    }
  }
  return null;
}

async function collectTilesFromSelector(page: Page, scope: Page | Frame, selector) {
  const locators = scope.locator(selector);
  const count = await locators.count().catch(() => 0);
  if (count < 3) return [];
  const found = [];
  const limit = Math.min(count, 16);
  for (let index = 0; index < limit; index += 1) {
    const tile = locators.nth(index);
    const visible = await tile.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await elementBoxInPage(page, scope, tile);
    if (!box) continue;
    const label = await tile.getAttribute("aria-label").catch(() => null);
    if (isCaptchaChromeLabel(label)) continue;
    found.push({ box, label: label || null });
  }
  const clustered = clusterSimilarBoxes(found.map((entry) => entry.box));
  if (clustered.length < 3) return [];
  return clustered.map((bounds, index) => {
    const match = found.find(
      (entry) =>
        Math.abs(entry.box.x - bounds.x) < 3 && Math.abs(entry.box.y - bounds.y) < 3,
    );
    return { index, bounds, label: match?.label || null };
  });
}

async function collectClickableCluster(page: Page, scope: Page | Frame) {
  const locators = scope.locator(
    "button, [role='button'], [role='checkbox'], img, [class*='task']",
  );
  const count = Math.min(await locators.count().catch(() => 0), 40);
  const found = [];
  for (let index = 0; index < count; index += 1) {
    const locator = locators.nth(index);
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const tag = await locator.evaluate((el) => el.tagName).catch(() => "");
    if (String(tag).toUpperCase() === "CANVAS") continue;
    const label = [
      await locator.getAttribute("aria-label").catch(() => ""),
      await locator.getAttribute("title").catch(() => ""),
      await locator.innerText().catch(() => ""),
    ]
      .map((value) => String(value || "").trim())
      .find(Boolean);
    if (isCaptchaChromeLabel(label)) continue;
    const box = await elementBoxInPage(page, scope, locator);
    if (box) found.push({ box, label: label || null });
  }
  const clustered = clusterSimilarBoxes(found.map((entry) => entry.box));
  return clustered.map((bounds, index) => {
    const match = found.find(
      (entry) =>
        Math.abs(entry.box.x - bounds.x) < 3 && Math.abs(entry.box.y - bounds.y) < 3,
    );
    return { index, bounds, label: match?.label || null };
  });
}

async function collectChallengeTiles(page: Page, provider) {
  const frames = candidateFrames(page, provider);
  const scopes = frames.length ? [...frames, page] : [page];
  const sets = [];
  for (const scope of scopes) {
    for (const selector of IMAGE_TILE_SELECTORS) {
      const tiles = await collectTilesFromSelector(page, scope, selector);
      if (tiles.length) sets.push(tiles);
    }
    const clickable = await collectClickableCluster(page, scope);
    if (clickable.length) sets.push(clickable);
  }
  return pickBestTileSet(sets);
}

// Identifies the grid a numbered crop was taken from. Tile indexes only mean
// something relative to the image the model looked at, so coordinates captured
// for one challenge must never be replayed against another.
export function captchaGridSignature(tiles, scroll = { x: 0, y: 0 }) {
  return tiles
    .map((tile) => {
      const box = tile.bounds || {};
      return [
        Math.round((box.x || 0) + scroll.x),
        Math.round((box.y || 0) + scroll.y),
        Math.round(box.width || 0),
        Math.round(box.height || 0),
      ].join(",");
    })
    .join("|");
}

function rememberCaptchaTiles(page: Page, session: CaptchaSession, tiles, scroll) {
  session.captchaTargets.clear();
  for (const tile of tiles) {
    session.captchaTargets.set(tile.index, {
      bounds: tile.bounds,
      pageBounds: {
        ...tile.bounds,
        x: tile.bounds.x + scroll.x,
        y: tile.bounds.y + scroll.y,
      },
      label: tile.label || null,
    });
  }
  session.captchaGrid = tiles.length
    ? { url: page.url(), signature: captchaGridSignature(tiles, scroll) }
    : null;
}

/**
 * True when the stored tile coordinates no longer describe what is on screen —
 * the page navigated, or the challenge swapped in a new grid. Clicking cached
 * boxes in that state hits the wrong tiles or unrelated controls, so callers
 * must recapture and let the model pick again rather than submit stale picks.
 */
export async function captchaTilesStale(page: Page, session: CaptchaSession, provider) {
  const stored = session.captchaGrid;
  if (!stored) return true;
  if (stored.url !== page.url()) return true;
  const live = await collectChallengeTiles(page, provider).catch(() => []);
  if (!live.length) return true;
  const scroll = await pageScrollMetrics(page);
  return captchaGridSignature(live, scroll) !== stored.signature;
}

function clipForPuzzle(tileBoxes, widgetBox, viewport) {
  if (
    widgetBox &&
    widgetBox.width >= 80 &&
    widgetBox.height >= 80 &&
    widgetBox.width <= 760 &&
    widgetBox.height <= 900
  ) {
    return unionClip([widgetBox], { pad: 8, promptPad: 0, viewport });
  }
  return unionClip(tileBoxes, { pad: 10, promptPad: 80, viewport });
}

export async function detectCaptchaOnPage(page: Page) {
  const metadata = await collectChallengeMetadata(page);
  const challenge = detectBotChallenge(metadata);
  const classification = classifyChallengeStage({
    ...metadata,
    provider: challenge?.provider,
    type: challenge?.type,
  });
  const widgets = [];
  const childFrames = page.frames().filter((frame) => frame !== page.mainFrame());
  for (const [index, frame] of childFrames.entries()) {
    if (metadata.frames[index]?.visible === false) continue;
    const url = frame.url() || "";
    for (const [provider, pattern] of Object.entries(WIDGET_FRAME_PATTERNS)) {
      if (pattern.test(url)) {
        widgets.push({ provider, url, kind: "frame" });
        break;
      }
    }
  }
  // Local fixtures may expose data-bw-captcha without provider frames.
  const localWidget = await page
    .locator(LOCAL_WIDGET_SELECTOR)
    .count()
    .then((count) => count > 0)
    .catch(() => false);
  if (localWidget) {
    widgets.push({ provider: "generic", url: page.url(), kind: "local" });
  }
  return {
    present: Boolean(challenge) || widgets.length > 0 || classification.stage !== CAPTCHA_STAGES.NONE,
    challenge: challenge || null,
    classification,
    widgets,
    tokens: metadata.tokens,
    cleared: Object.keys(metadata.tokens).length > 0,
    url: page.url(),
  };
}

export function createCaptchaRuntime<Session extends CaptchaSession>({
  captureScreenshot,
}: CaptchaRuntimeDeps<Session>) {
  async function capturePuzzleScreenshot(page: Page, session: Session, name, clip, extra: any = {}) {
    const options: PageScreenshotOptions = {
      type: "png",
      animations: extra.animations ?? "disabled",
      timeout: CAPTCHA_SCREENSHOT_TIMEOUT_MS,
    };
    try {
      return await captureScreenshot(
        page,
        session,
        name,
        name,
        clip ? { ...options, clip } : options,
      );
    } catch {
      return captureScreenshot(page, session, name, name, options);
    }
  }

  async function captureTiles(page: Page, session: Session, provider) {
    const tiles = await collectChallengeTiles(page, provider);
    const scroll = await pageScrollMetrics(page);
    rememberCaptchaTiles(page, session, tiles, scroll);
    const widgetBox = await challengeWidgetBox(page, provider);
    const viewport = page.viewportSize();
    const clip = tiles.length
      ? clipForPuzzle(
          tiles.map((tile) => tile.bounds),
          widgetBox,
          viewport,
        )
      : widgetBox
        ? unionClip([widgetBox], { pad: 8, promptPad: 0, viewport })
        : null;
    let overlayDrawn = false;
    if (tiles.length) {
      try {
        await page.evaluate(drawCaptchaTileOverlay, {
          tiles,
          overlayId: CAPTCHA_TILE_OVERLAY_ID,
        });
        overlayDrawn = true;
      } catch {
        overlayDrawn = false;
      }
    }
    let file;
    try {
      file = await capturePuzzleScreenshot(page, session, "captcha-grid.png", clip);
    } finally {
      if (overlayDrawn) {
        await page
          .evaluate(removeAnnotationOverlay, CAPTCHA_TILE_OVERLAY_ID)
          .catch(() => {});
      }
    }
    const artifact = { kind: "captcha", path: file, media: `MEDIA:${file}` };
    session.artifacts.push(artifact);
    const prompt = await readChallengeInstruction(page, provider);
    const grid = gridFromTiles(tiles);
    return {
      tiles,
      artifact,
      grid,
      prompt,
      instruction: visionGridInstruction({
        prompt,
        grid,
        tileCount: tiles.length,
      }),
    };
  }

  async function clickStoredTiles(page: Page, session: Session, indexes) {
    if (!session.captchaTargets.size) return { ok: false, reason: "tiles_not_captured" };
    const scopes = [page, ...page.frames().filter((frame) => frame !== page.mainFrame()).slice(0, 8)];
    const previousLabel = await recaptchaVerifyButtonLabel(scopes);
    const hadSelection = await anyScopeHasSelectedCaptchaTiles(scopes);
    const clicked = [];
    for (const index of indexes) {
      const tile = session.captchaTargets.get(index);
      if (!tile?.bounds) continue;
      const visibleBounds = await captchaBoxInViewport(
        page,
        tile.pageBounds || tile.bounds,
        Boolean(tile.pageBounds),
      );
      await humanClickBox(page, session, visibleBounds, { leftBias: false });
      clicked.push(index);
      await hostDelay(70 + Math.random() * 140);
    }
    if (!clicked.length) return { ok: false, reason: "tiles_not_found" };
    // The Skip/Verify label flips only after the last tile click lands.
    const verify = await waitForVerifyControl(page, scopes, 2_500, {
      previousLabel,
      hadSelection,
    });
    if (!verify) {
      return { ok: true, clicked, verified: false, reason: "verify_not_ready" };
    }
    await hostDelay(80 + Math.random() * 120);
    await humanClickControl(page, session, verify.box, { leftBias: false });
    return { ok: true, clicked, verified: true, label: verify.label || null };
  }

  async function dragSliderOnPage(page: Page, session: Session, provider) {
    const scopes = [page, ...candidateFrames(page, provider)];
    const found = await findClickableInScopes(page, scopes, SLIDER_SELECTORS);
    if (!found) return { ok: false, reason: "slider_not_found" };
    const { box } = found;
    const start = {
      x: Math.round(box.x + box.width * 0.5),
      y: Math.round(box.y + box.height * 0.5),
    };
    // Prefer the track width when the handle is small; drag most of the way across.
    const trackWidth = Math.max(box.width * 4, 220);
    const end = {
      x: Math.round(start.x + trackWidth * (0.82 + Math.random() * 0.1)),
      y: Math.round(start.y + (Math.random() - 0.5) * 4),
    };
    await movePointer(page.mouse, session.cursor, start, { stepDivisor: 8 });
    await hostDelay(100 + Math.random() * 120);
    await page.mouse.down();
    await hostDelay(80 + Math.random() * 100);
    await movePointer(page.mouse, session.cursor, end, {
      stepDivisor: Math.max(3, Math.hypot(end.x - start.x, end.y - start.y) / 24),
    });
    await hostDelay(80 + Math.random() * 120);
    await page.mouse.up();
    return { ok: true, from: start, to: end };
  }

  async function sampleCanvasRgba(scope: Page | Frame) {
    const locator = scope.locator("canvas").first();
    const handle = await locator.elementHandle({ timeout: 800 }).catch(() => null);
    if (!handle) return null;
    try {
      const box = await handle.boundingBox();
      const image = await handle
        .evaluate(sampleCanvasRgbaInPage, 200)
        .catch(() => null);
      if (!image || !box || box.width < 16 || box.height < 16) return null;
      return { image, box };
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  async function decodePngRgba(page: Page, buffer, maxWidth = 220) {
    const b64 = Buffer.from(buffer).toString("base64");
    return page.evaluate(
      async ({ b64, maxWidth }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const scale = Math.min(1, maxWidth / img.naturalWidth);
        const width = Math.max(8, Math.round(img.naturalWidth * scale));
        const height = Math.max(8, Math.round(img.naturalHeight * scale));
        const copy = document.createElement("canvas");
        copy.width = width;
        copy.height = height;
        const ctx = copy.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, width, height);
        const pixels = ctx.getImageData(0, 0, width, height);
        return { width, height, data: Array.from(pixels.data) };
      },
      { b64, maxWidth },
    );
  }

  async function screenshotRgba(page: Page, session: Session, clip) {
    const file = await capturePuzzleScreenshot(
      page,
      session,
      "captcha-motion-frame.png",
      clip,
      { animations: "allow" },
    );
    const buffer = fs.readFileSync(file);
    const image = await decodePngRgba(page, buffer);
    return { image, box: clip, file };
  }

  function bestGrownFromSamples(samples, options) {
    let best = null;
    for (let i = 0; i < samples.length; i += 1) {
      for (let j = i + 1; j < samples.length; j += 1) {
        const grown = findGrowingRegion(samples[i].image, samples[j].image, options);
        if (!grown) continue;
        if (!best || grown.score > best.grown.score) {
          best = { grown, sample: samples[j] };
        }
      }
    }
    return best;
  }

  async function locateGrowingRegion(page: Page, session: Session, provider) {
    const scopes = [...candidateFrames(page, provider), page];
    for (const scope of scopes) {
      const samples = [];
      for (let i = 0; i < 3; i += 1) {
        if (i > 0) await hostDelay(420);
        const sample = await sampleCanvasRgba(scope);
        if (sample) samples.push(sample);
      }
      const picked = bestGrownFromSamples(samples, { topInset: 0, bottomInset: 0 });
      if (picked?.grown) {
        return {
          bounds: blobToPageBounds(picked.grown, picked.sample.image, picked.sample.box),
          score: picked.grown.score,
          confidence: picked.grown.confidence,
          source: "canvas",
        };
      }
    }
    const widgetBox = await challengeWidgetBox(page, provider);
    const clip = widgetBox
      ? unionClip([widgetBox], {
          pad: 8,
          promptPad: 0,
          viewport: page.viewportSize(),
        })
      : null;
    if (!clip) return null;
    const shots = [];
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) await hostDelay(420);
      const shot = await screenshotRgba(page, session, clip);
      if (shot?.image) shots.push(shot);
    }
    const picked = bestGrownFromSamples(shots, { topInset: 0.12, bottomInset: 0.18 });
    if (!picked?.grown) return null;
    return {
      bounds: blobToPageBounds(picked.grown, picked.sample.image, picked.sample.box),
      score: picked.grown.score,
      confidence: picked.grown.confidence,
      source: "screenshot",
      artifact: picked.sample.file,
    };
  }

  async function confirmMotionSelection(page: Page, session: Session, provider) {
    const frames = candidateFrames(page, provider);
    const found = await findClickableInScopes(
      page,
      frames,
      MOTION_CONFIRM_SELECTORS,
    );
    if (!found) return false;
    await humanClickBox(page, session, found.box, { leftBias: false });
    return true;
  }

  async function dragFitOnPage(page: Page, session: Session, provider) {
    const scopes = [...candidateFrames(page, provider), page];
    for (const scope of scopes) {
      const sample = await sampleCanvasRgba(scope);
      if (!sample) continue;
      const pair = pickDragFitPair(extractDarkBlobs(sample.image));
      if (!pair) continue;
      const from = blobToPageBounds(pair.piece, sample.image, sample.box, 4);
      const to = blobToPageBounds(pair.hole, sample.image, sample.box, 4);
      await movePointer(
        page.mouse,
        session.cursor,
        { x: from.cx, y: from.cy },
        { stepDivisor: 8 },
      );
      await hostDelay(90 + Math.random() * 120);
      await page.mouse.down();
      await hostDelay(70 + Math.random() * 90);
      await movePointer(
        page.mouse,
        session.cursor,
        { x: to.cx, y: to.cy },
        {
          stepDivisor: Math.max(
            3,
            Math.hypot(to.cx - from.cx, to.cy - from.cy) / 22,
          ),
        },
      );
      await hostDelay(80 + Math.random() * 100);
      await page.mouse.up();
      return { ok: true, from, to, source: "canvas" };
    }
    return { ok: false, reason: "drag_fit_not_found" };
  }

  async function runCaptchaSolveAction(
    page: Page,
    session: Session,
    classification,
    action,
  ): Promise<any> {
    const provider = classification.provider;
    const scopes = [page, ...candidateFrames(page, provider)];
    switch (action.action) {
      case "click_checkbox": {
        // Prefer real checkbox/controls; never fall through to a bare `body` hit
        // when a verify button is available (managed / generic widgets).
        // The widget's own control first, then the widget itself, and only then
        // generic page buttons. Order matters: VERIFY_BUTTON_SELECTORS ends in
        // `button[type='submit']`, which on a demo or login page is the host
        // form's own button. Reaching that before the widget submits the form
        // unsolved while the attempt log still claims a successful click.
        const preferred = CHECKBOX_SELECTORS.filter((selector) => selector !== "body");
        let found = await findClickableInScopes(page, scopes, preferred);
        if (!found) {
          // Turnstile mounts its iframe in a CLOSED shadow root, so neither the
          // DOM nor a Playwright selector can see it. The frame stays attached
          // and its frame element still reports real page geometry, which is the
          // only remaining way to reach the checkbox.
          const frameBox = await widgetFrameBox(page, provider);
          if (frameBox) {
            const point = await humanClickBox(page, session, frameBox, { leftBias: true });
            return { ok: true, point, target: "frame_element" };
          }
          // Widget iframes that are visible in the DOM. Every pattern has to name
          // a challenge: a bare `title*="widget"` also matches ordinary site
          // furniture such as chat launchers, and clicking one of those reports a
          // solve while opening a support window.
          const iframe = page
            .locator(
              'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], iframe[src*="challenges.cloudflare" i], iframe[title*="captcha" i], iframe[title*="challenge" i], iframe[title*="verification" i], iframe[title*="security check" i]',
            )
            .first();
          // Bounded: an unmatched locator otherwise blocks for Playwright's 30s
          // default, which is the whole solve budget spent before the first click.
          const box = await iframe.boundingBox({ timeout: 800 }).catch(() => null);
          if (box) {
            const point = await humanClickBox(page, session, box, { leftBias: true });
            return { ok: true, point, target: "iframe" };
          }
          // The widget container itself, for challenges that render inline rather
          // than in a frame. Still ahead of the generic buttons below.
          const inlineBox = await challengeWidgetClickBox(page, provider);
          if (inlineBox) {
            const point = await humanClickBox(page, session, inlineBox, { leftBias: true });
            return { ok: true, point, target: "widget" };
          }
          found = await findVerifyControl(page, scopes);
          if (!found) return { ok: false, reason: "checkbox_not_found" };
          const verifyPoint = await humanClickControl(page, session, found.box, {
            leftBias: found.box.width > 80,
          });
          return {
            ok: true,
            point: verifyPoint,
            target: "verify_button",
            selector: found.selector || null,
          };
        }
        const point = await humanClickControl(page, session, found.box, {
          leftBias: found.box.width > 80,
        });
        return { ok: true, point, target: "checkbox", selector: found.selector || null };
      }
      case "click_verify": {
        // Challenge-frame controls first so a host-page Submit cannot steal the
        // click. Next is how hCaptcha confirms a motion-target selection.
        const frames = candidateFrames(page, provider);
        const found =
          (await findVerifyControl(page, [...frames, page])) ||
          (await findClickableInScopes(page, [...frames, page], CHECKBOX_SELECTORS));
        if (!found) return { ok: false, reason: "verify_control_not_found", soft: true };
        const point = await humanClickControl(page, session, found.box, {
          leftBias: false,
        });
        return { ok: true, point, target: "verify" };
      }
      case "drag_slider": {
        const slider = await dragSliderOnPage(page, session, provider);
        if (slider.ok) return slider;
        const fit = await dragFitOnPage(page, session, provider);
        if (fit.ok) return fit;
        return { ...slider, soft: true };
      }
      case "click_growing": {
        const located = await locateGrowingRegion(page, session, provider);
        if (!located?.bounds) {
          return runCaptchaSolveAction(page, session, classification, {
            action: "inspect",
            waitMs: 0,
            description: "Motion target was ambiguous; capture frames for host vision",
          });
        }
        await humanClickBox(page, session, located.bounds, { leftBias: false });
        await hostDelay(700 + Math.random() * 400);
        const confirmed = await confirmMotionSelection(page, session, provider);
        return {
          ok: true,
          auto: true,
          confirmed,
          target: located,
          source: located.source,
        };
      }
      case "capture_tiles": {
        const captured = await captureTiles(page, session, provider);
        return {
          ok: true,
          needsVision: true,
          tiles: captured.tiles,
          artifact: captured.artifact,
          grid: captured.grid,
          instruction: captured.instruction,
        };
      }
      case "capture_text": {
        const widgetBox = await challengeWidgetBox(page, provider);
        const file = await capturePuzzleScreenshot(
          page,
          session,
          "captcha-text.png",
          widgetBox
            ? unionClip([widgetBox], {
                pad: 8,
                promptPad: 0,
                viewport: page.viewportSize(),
              })
            : null,
        );
        const artifact = { kind: "captcha", path: file, media: `MEDIA:${file}` };
        session.artifacts.push(artifact);
        return {
          ok: true,
          needsVision: true,
          artifact,
          instruction: "Read the attached CAPTCHA crop and type the text into the challenge input.",
        };
      }
      case "wait_token":
      case "wait_clear":
        return { ok: true, waited: true };
      case "inspect": {
        const widgetBox = await challengeWidgetBox(page, provider);
        const clip = widgetBox
          ? unionClip([widgetBox], {
              pad: 8,
              promptPad: 0,
              viewport: page.viewportSize(),
            })
          : null;
        const file = await capturePuzzleScreenshot(
          page,
          session,
          "captcha-challenge.png",
          clip,
          { animations: "allow" },
        );
        const artifact = { kind: "captcha", path: file, media: `MEDIA:${file}` };
        session.artifacts.push(artifact);
        await hostDelay(450);
        let artifact2 = null;
        try {
          const file2 = await capturePuzzleScreenshot(
            page,
            session,
            "captcha-challenge-b.png",
            clip,
            { animations: "allow" },
          );
          artifact2 = { kind: "captcha", path: file2, media: `MEDIA:${file2}` };
          session.artifacts.push(artifact2);
        } catch {
          artifact2 = null;
        }
        return {
          ok: true,
          needsVision: true,
          artifact,
          artifact2,
          instruction:
            "Compare the two attached frames and click the shape that grew, then call captcha.solve() again so Next can confirm. This is not a numbered image grid.",
        };
      }
      default:
        return { ok: false, reason: `unknown_action:${action.action}` };
    }
  }

  async function solveCaptchaOnPage(page: Page, session: Session, options: any = {}) {
    const started = Date.now();
    const timeoutMs = solveTimeoutMs(options);
    const maxStages = maxAutoStages(options);
    const attempts = [];
    const requestId = `bw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    let lastClassification = null;
    let lastChallenge = null;
    let lastArtifact = null;
    let lastTiles = null;
    let lastInstruction = null;
    let lastGrid = null;
    let pendingTiles = parseTileIndexes(options?.tiles ?? options?.indexes);

    for (let stageIndex = 0; stageIndex < maxStages; stageIndex += 1) {
      if (Date.now() - started > timeoutMs) {
        return buildSolveResult({
          status: CAPTCHA_SOLVE_STATUSES.ERROR,
          requestId,
          provider: lastClassification?.provider || "generic",
          stage: lastClassification?.stage || CAPTCHA_STAGES.UNKNOWN,
          errorCode: "ERROR_TIMEOUT",
          errorText: `CAPTCHA solve timed out after ${timeoutMs}ms`,
          attempts,
          artifact: lastArtifact,
          tiles: lastTiles,
          grid: lastGrid,
          instruction: lastInstruction,
          challenge: lastChallenge,
        });
      }

      const metadata = await collectChallengeMetadata(page);
      if (Object.keys(metadata.tokens).length) {
        const provider = Object.keys(metadata.tokens)[0];
        return buildSolveResult({
          status: CAPTCHA_SOLVE_STATUSES.READY,
          requestId,
          provider,
          stage: CAPTCHA_STAGES.NONE,
          token: metadata.tokens[provider],
          attempts,
          cleared: true,
          challenge: lastChallenge,
        });
      }

      const challenge = detectBotChallenge(metadata);
      lastChallenge = challenge;
      const classification = classifyChallengeStage({
        ...metadata,
        provider: challenge?.provider,
        type: challenge?.type,
      });
      lastClassification = classification;

      // Local fixture widgets without provider frames.
      if (classification.stage === CAPTCHA_STAGES.NONE) {
        const local = await page
          .locator(LOCAL_WIDGET_SELECTOR)
          .first()
          .isVisible()
          .catch(() => false);
        if (!local) {
          // No challenge visible — treat as cleared.
          return buildSolveResult({
            status: CAPTCHA_SOLVE_STATUSES.READY,
            requestId,
            provider: "generic",
            stage: CAPTCHA_STAGES.NONE,
            attempts,
            cleared: true,
            challenge: null,
          });
        }
        lastClassification = {
          stage: CAPTCHA_STAGES.CHECKBOX,
          provider: "generic",
          autoSolvable: true,
          needsVision: false,
        };
        const kind = await page
          .locator(LOCAL_WIDGET_SELECTOR)
          .first()
          .getAttribute("data-bw-captcha")
          .catch(() => "");
        if (kind === "grid") {
          lastClassification = {
            stage: CAPTCHA_STAGES.IMAGE_GRID,
            provider: "generic",
            autoSolvable: false,
            needsVision: true,
          };
        } else if (kind === "slider") {
          lastClassification = {
            stage: CAPTCHA_STAGES.SLIDER,
            provider: "generic",
            autoSolvable: true,
            needsVision: false,
          };
        } else if (kind === "motion") {
          lastClassification = {
            stage: CAPTCHA_STAGES.MOTION,
            provider: "generic",
            autoSolvable: true,
            needsVision: false,
          };
        } else if (kind === "drag") {
          lastClassification = {
            stage: CAPTCHA_STAGES.SLIDER,
            provider: "generic",
            autoSolvable: true,
            needsVision: false,
          };
        }
      }

      if (pendingTiles.length && lastClassification.stage === CAPTCHA_STAGES.IMAGE_GRID) {
        // Tile indexes describe the numbered crop the caller looked at. If that
        // grid is gone, recapture and ask for fresh picks: replaying the old
        // coordinates would click the wrong tiles and then submit Verify.
        const stale =
          !session.captchaTargets.size ||
          (await captchaTilesStale(page, session, lastClassification.provider));
        if (stale) {
          const captured = await captureTiles(page, session, lastClassification.provider);
          lastArtifact = captured.artifact;
          lastTiles = captured.tiles;
          lastGrid = captured.grid;
          lastInstruction = captured.instruction;
          pendingTiles = [];
          attempts.push({
            stageIndex,
            stage: lastClassification.stage,
            provider: lastClassification.provider,
            action: "recapture_tiles",
            description: "The numbered grid changed; captured a fresh crop for new picks",
            ok: true,
            reason: "grid_changed",
            atMs: Date.now() - started,
          });
          return buildSolveResult({
            status: CAPTCHA_SOLVE_STATUSES.PROCESSING,
            requestId,
            provider: lastClassification.provider,
            stage: lastClassification.stage,
            attempts,
            artifact: lastArtifact,
            tiles: lastTiles,
            grid: lastGrid,
            instruction:
              lastInstruction ||
              "The captcha grid changed. Open the attached numbered crop, pick matching tile indexes, then call captcha.solve({ tiles: [indexes] }).",
            challenge: lastChallenge,
          });
        }
        const outcome = await clickStoredTiles(page, session, pendingTiles);
        const applied = pendingTiles;
        pendingTiles = [];
        attempts.push({
          stageIndex,
          stage: lastClassification.stage,
          provider: lastClassification.provider,
          action: "click_tiles",
          description: `Click numbered tiles ${applied.join(", ")} and verify`,
          ok: Boolean(outcome.ok),
          reason: outcome.reason || null,
          atMs: Date.now() - started,
        });
        if (!outcome.ok) {
          return buildSolveResult({
            status: CAPTCHA_SOLVE_STATUSES.ERROR,
            requestId,
            provider: lastClassification.provider,
            stage: lastClassification.stage,
            errorCode: "ERROR_ACTION_FAILED",
            errorText: outcome.reason || "CAPTCHA tile click failed",
            attempts,
            artifact: lastArtifact,
            tiles: lastTiles,
            grid: lastGrid,
            instruction: lastInstruction,
            challenge: lastChallenge,
          });
        }
        await hostDelay(1_600 + Math.random() * 900);
        const afterTiles = await challengeStillPresent(page, lastClassification.provider);
        if (!afterTiles.present) {
          const provider =
            Object.keys(afterTiles.metadata.tokens || {})[0] || lastClassification.provider;
          return buildSolveResult({
            status: CAPTCHA_SOLVE_STATUSES.READY,
            requestId,
            provider,
            stage: lastClassification.stage,
            token: afterTiles.metadata.tokens?.[provider] || null,
            attempts,
            cleared: true,
            challenge: lastChallenge,
          });
        }
        continue;
      }

      let action = nextSolveAction(lastClassification, stageIndex);
      if (lastClassification.stage === CAPTCHA_STAGES.MOTION) {
        const frames = candidateFrames(page, lastClassification.provider);
        const confirm = await findClickableInScopes(page, frames, [
          ":text-is('Next')",
          "button:has-text('Next')",
          "[role='button']:has-text('Next')",
        ]);
        if (confirm) {
          action = {
            action: "click_verify",
            waitMs: 2_000,
            description: "Confirm the selected motion target",
          };
        }
      }
      const outcome = await runCaptchaSolveAction(
        page,
        session,
        lastClassification,
        action,
      );
      attempts.push({
        stageIndex,
        stage: lastClassification.stage,
        provider: lastClassification.provider,
        action: action.action,
        description: action.description,
        ok: Boolean(outcome.ok),
        reason: outcome.reason || null,
        // Which control the action actually hit. Without this a click on the
        // wrong element is indistinguishable from a click on the widget.
        target: outcome.target || null,
        selector: outcome.selector || null,
        atMs: Date.now() - started,
      });

      if (outcome.artifact) lastArtifact = outcome.artifact;
      if (outcome.tiles) lastTiles = outcome.tiles;
      if (outcome.instruction) lastInstruction = outcome.instruction;
      if (outcome.grid) lastGrid = outcome.grid;

      if (outcome.needsVision) {
        return buildSolveResult({
          status: CAPTCHA_SOLVE_STATUSES.PROCESSING,
          requestId,
          provider: lastClassification.provider,
          stage: lastClassification.stage,
          attempts,
          artifact: lastArtifact,
          tiles: lastTiles,
          grid: lastGrid,
          instruction:
            lastInstruction ||
            "Open the attached numbered captcha crop, pick matching tile indexes, then call captcha.solve({ tiles: [indexes] }).",
          challenge: lastChallenge,
        });
      }

      if (!outcome.ok && !outcome.soft) {
        // Soft failures (e.g. verify button absent on managed challenge) still wait.
        if (stageIndex === maxStages - 1) {
          return buildSolveResult({
            status: CAPTCHA_SOLVE_STATUSES.ERROR,
            requestId,
            provider: lastClassification.provider,
            stage: lastClassification.stage,
            errorCode: "ERROR_ACTION_FAILED",
            errorText: outcome.reason || "CAPTCHA action failed",
            attempts,
            artifact: lastArtifact,
            challenge: lastChallenge,
          });
        }
      }

      if (action.waitMs > 0) {
        await hostDelay(action.waitMs);
      }

      const after = await challengeStillPresent(page, lastClassification.provider);
      if (!after.present) {
        const provider =
          Object.keys(after.metadata.tokens || {})[0] || lastClassification.provider;
        return buildSolveResult({
          status: CAPTCHA_SOLVE_STATUSES.READY,
          requestId,
          provider,
          stage: lastClassification.stage,
          token: after.metadata.tokens?.[provider] || null,
          attempts,
          cleared: true,
          challenge: lastChallenge,
        });
      }
    }

    return buildSolveResult({
      status: CAPTCHA_SOLVE_STATUSES.PROCESSING,
      requestId,
      provider: lastClassification?.provider || "generic",
      stage: lastClassification?.stage || CAPTCHA_STAGES.UNKNOWN,
      attempts,
      artifact: lastArtifact,
      tiles: lastTiles,
      grid: lastGrid,
      instruction:
        lastInstruction ||
        "Auto-solve stages exhausted. Inspect the page with captcha.inspect or hand off to a human.",
      challenge: lastChallenge,
      errorCode: null,
      errorText: null,
    });
  }

  return { captureTiles, clickStoredTiles, solveCaptchaOnPage };
}
