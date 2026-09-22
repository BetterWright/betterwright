// Challenge metadata collection and per-session reporting. Importing this module
// does not start a worker or browser. Serialized page callbacks stay self-contained.
import type { Frame, Page, PageScreenshotOptions } from "playwright-core";
import { classifyChallengeStage } from "./captcha-solver.js";
import { challengeScanNeeded, detectBotChallenge } from "./challenges.js";
import type { UntrustedValue } from "./untrusted-value.js";

export interface ChallengeSession {
  currentId: string | null;
  pages: Map<string, Page>;
  artifacts: { kind: string; path: string; media: string }[];
  openChallengeProviders: Set<string>;
}

export type CaptureChallengeScreenshot<Session> = (
  page: Page,
  session: Session,
  requested: string,
  fallback: string,
  options: PageScreenshotOptions,
) => Promise<string>;

interface ChallengeScanDeps<Session> {
  captureScreenshot: CaptureChallengeScreenshot<Session>;
  pageId: (page: Page) => string;
  lastBlockedDocumentAt: (page: Page) => number | undefined;
}

const CHALLENGE_FRAME_LIMIT = 24;
const CHALLENGE_MAIN_TEXT_LIMIT = 50_000;
const CHALLENGE_FRAME_TEXT_LIMIT = 10_000;
const CHALLENGE_MAIN_TEXT_TIMEOUT_MS = 750;
const CHALLENGE_FRAME_TEXT_TIMEOUT_MS = 500;
// The frame walk is work the main-frame read did not do before, so it gets its
// own budget rather than borrowing the body-text one: a page slow enough to
// lose the walk must still report its title, text and solved-provider tokens.
const CHALLENGE_FRAME_WALK_TIMEOUT_MS = 750;
// In-page ceiling for the same-origin text walk, so one slow frame layout
// cannot spend the whole evaluate budget by itself.
const CHALLENGE_WALK_BUDGET_MS = 250;
const CHALLENGE_CHECKED_SELECTOR =
  '[aria-checked="true"], input[type="checkbox"]:checked, .recaptcha-checkbox-checked';
const CHALLENGE_COMPLETED_TEXT =
  /verification (?:complete|successful)|success!|you are verified/i;
// Navigation destroys the execution context a pending evaluate was scheduled
// in. The locator APIs retry that internally, inside their own timeout;
// `evaluate` surfaces it as a rejection, so it is retried once here to keep a
// mid-scan navigation from blanking a field the old per-call reads kept.
const CHALLENGE_EVALUATE_RETRY =
  /execution context was destroyed|frame was detached|cannot find context/i;

/**
 * Filled challenge response fields, keyed by provider. Runs in the page's main
 * world because the fields are page state, which is where this read has always
 * lived.
 */
export const readSolvedProvidersInPage = () => {
  const isResponseText = (value: UntrustedValue): value is string =>
    typeof value === "string";
  const read = (name) => {
    const fields = [...document.querySelectorAll(`[name="${name}"]`)];
    if (fields.length === 0) return "";
    const values = fields.map((element) => {
      // SAFETY: challenge response fields are <input>/<textarea>, whose `value`
      // is a string; any other element carrying the name reads undefined here
      // and fails the guard below, counting as unfilled.
      const fieldValue = (element as { value?: UntrustedValue }).value;
      return isResponseText(fieldValue) ? fieldValue.trim() : "";
    });
    // A provider only counts as solved once every response field is filled;
    // a partially populated multi-widget page is still an open challenge.
    return values.every(Boolean) ? values[0] : "";
  };
  const tokens: Record<string, string> = {};
  const recaptcha = read("g-recaptcha-response");
  const hcaptcha = read("h-captcha-response");
  const turnstile = read("cf-turnstile-response");
  if (recaptcha) tokens.recaptcha = recaptcha;
  if (hcaptcha) tokens.hcaptcha = hcaptcha;
  if (turnstile) tokens.turnstile = turnstile;
  // Generic local fixture / self-hosted widgets.
  const generic = read("bw-captcha-response") || read("captcha-response");
  if (generic) tokens.generic = generic;
  return tokens;
};

/**
 * Child-frame geometry, plus the text of the same-origin ones when the caller
 * is about to gate on it. One evaluate for the whole document tree instead of a
 * round trip per frame. Serialized into the page, so it closes over no worker
 * scope; `contentDocument` reaches same-origin frames (including `srcdoc`) and
 * nothing else, which is why cross-origin frames still cost stage 2.
 */
export const readFrameWalkInPage = (options: any) => {
  const isTextValue = (value: UntrustedValue): value is string =>
    typeof value === "string";
  const deadline = performance.now() + options.walkBudgetMs;
  const presentationOf = (element) => {
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument?.defaultView;
    const style = view ? view.getComputedStyle(element) : null;
    return {
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        (!style ||
          (style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0)),
      width: rect.width,
      height: rect.height,
    };
  };
  // Only this document's own children: a nested frame's descriptors are read
  // from that frame, and an iframe inside a shadow root (which
  // `querySelectorAll` does not reach) is resolved through its own element by
  // the caller rather than by walking every element on the page.
  const elements = [...document.querySelectorAll("iframe, frame")].slice(
    0,
    options.frameLimit,
  );
  const iframes = elements.map((element) => ({
    name: element.getAttribute("name") || element.getAttribute("id") || "",
    // SAFETY: the selector matches only <iframe>/<frame> elements, whose `src`
    // IDL attribute is a string; an impostor from another namespace reads
    // undefined here, which || "" normalizes.
    src: (element as { src?: string }).src || "",
    ...presentationOf(element),
  }));

  const sameOrigin = [];
  if (options.wantFrameText) {
    const queue = [document];
    while (queue.length > 0 && sameOrigin.length < options.frameLimit) {
      if (performance.now() > deadline) break;
      const scope = queue.shift();
      let nested = [];
      try {
        nested = [...scope.querySelectorAll("iframe, frame")];
      } catch {
        continue;
      }
      for (const element of nested) {
        if (sameOrigin.length >= options.frameLimit) break;
        if (performance.now() > deadline) break;
        let inner = null;
        try {
          inner = element.contentDocument;
        } catch {
          inner = null;
        }
        if (!inner) {
          const srcdoc = element.getAttribute("srcdoc");
          if (srcdoc) {
            const parsed = document.createElement("div");
            parsed.innerHTML = srcdoc;
            sameOrigin.push({
              url: "about:srcdoc",
              title: parsed.querySelector("title")?.textContent || "",
              text: String(parsed.innerText || parsed.textContent || "").slice(
                0,
                options.frameTextLimit,
              ),
              visible: presentationOf(element).visible,
            });
          }
          continue;
        }
        const innerBody = inner.body;
        let frameText = isTextValue(innerBody?.innerText)
          ? innerBody.innerText
          : String(innerBody?.textContent || "");
        let frameTitle = inner.title || "";
        if (!frameText) {
          const srcdoc = element.getAttribute("srcdoc");
          if (srcdoc) {
            const parsed = document.createElement("div");
            parsed.innerHTML = srcdoc;
            frameText = String(parsed.innerText || parsed.textContent || "");
            frameTitle = parsed.querySelector("title")?.textContent || frameTitle;
          }
        }
        sameOrigin.push({
          url: inner.location ? String(inner.location.href) : "",
          title: frameTitle,
          text: frameText.slice(0, options.frameTextLimit),
          visible: presentationOf(element).visible,
        });
        queue.push(inner);
      }
    }
  }
  return { iframes, sameOrigin };
};

/**
 * Geometry of one frame element, read through the element itself. Duplicates
 * `presentationOf` above because in-page functions are serialized and cannot
 * share worker-scope helpers.
 */
export const readFramePresentationInPage = (element) => {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument?.defaultView;
  const style = view ? view.getComputedStyle(element) : null;
  return {
    visible:
      rect.width > 0 &&
      rect.height > 0 &&
      (!style ||
        (style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0)),
    width: rect.width,
    height: rect.height,
  };
};

function emptyFrameWalk() {
  return { iframes: [], sameOrigin: [] };
}

async function evaluateOnce(target, fn, arg?) {
  try {
    return await target.evaluate(fn, arg);
  } catch (error: any) {
    if (!CHALLENGE_EVALUATE_RETRY.test(String(error?.message || ""))) throw error;
    return target.evaluate(fn, arg);
  }
}

// A hung page must degrade to the same empty value the old per-call `.catch()`
// handlers produced, and must not leave a rejected evaluate unhandled once the
// race is over.
async function withChallengeTimeout(work, timeoutMs, fallback) {
  let timer;
  return Promise.race([
    work,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function readSolvedProviders(page: Page): Promise<Record<string, string>> {
  return evaluateOnce(page, readSolvedProvidersInPage).catch(() => ({}));
}

async function readFrameWalk(target, options) {
  return withChallengeTimeout(
    evaluateOnce(target, readFrameWalkInPage, options).catch(() => emptyFrameWalk()),
    CHALLENGE_FRAME_WALK_TIMEOUT_MS,
    emptyFrameWalk(),
  );
}

/**
 * Text and solved-checkbox state of one frame. Both go through Playwright's
 * locator APIs, which run in an isolated utility world: a page cannot hide its
 * own prompt by patching `innerText`, nor declare its challenge solved by
 * patching `querySelector`, and the CSS engine pierces open shadow roots the
 * way a widget's own checkbox is usually rendered.
 */
async function readFrameSurface(frame: Frame) {
  const [text, checked] = await Promise.all([
    frame
      .locator("body")
      .innerText({ timeout: CHALLENGE_FRAME_TEXT_TIMEOUT_MS })
      .catch(() => ""),
    frame
      .locator(CHALLENGE_CHECKED_SELECTOR)
      .count()
      .then((count) => count > 0)
      .catch(() => false),
  ]);
  return { text: text.slice(0, CHALLENGE_FRAME_TEXT_LIMIT), checked };
}

function claimUnique(pool, matches) {
  let found = null;
  for (const entry of pool) {
    if (entry.used || !matches(entry)) continue;
    // Two candidates identify nothing: duplicate ad frames and duplicate
    // widgets share both name and URL, and guessing between them would attach
    // one frame's visibility to the other.
    if (found) return null;
    found = entry;
  }
  if (found) found.used = true;
  return found;
}

// Playwright's `frame.name()` reports the frame element's name attribute and
// falls back to its id, so both identify a frame exactly. `src` is the element
// attribute, which only equals `frame.url()` while the frame has not navigated
// itself. Anything left over is resolved through its own element instead of
// being guessed at: a descriptor borrowed from a sibling could report
// `visible: false`, and that is the one value that makes the detector drop a
// real challenge.
function matchFrameDescriptor(frame: Frame, pool) {
  if (!pool.length) return null;
  const name = frame.name();
  const byName = name ? claimUnique(pool, (entry) => entry.name === name) : null;
  if (byName) return byName;
  const url = frame.url();
  return url ? claimUnique(pool, (entry) => entry.src && entry.src === url) : null;
}

async function resolveFramePresentation(frame: Frame) {
  return frame
    .frameElement()
    .then(async (element) => {
      try {
        return await element.evaluate(readFramePresentationInPage);
      } finally {
        await element.dispose().catch(() => {});
      }
    })
    .catch(() => null);
}

// Stage 2 of the challenge scan: two parallel locator reads per frame instead
// of the five sequential CDP round-trips (frameElement, rect/style, dispose,
// innerText, checkbox count) this used to cost, with the geometry coming from
// the parent's single descriptor walk. `mainDescriptors` is the main frame's
// share of that, already collected by stage 1.
async function collectFrameMetadata(page: Page, childFrames: Frame[], mainDescriptors) {
  if (!childFrames.length) return [];
  const mainFrame = page.mainFrame();
  const parents = new Set();
  for (const frame of childFrames) {
    const parent = frame.parentFrame();
    if (parent && parent !== mainFrame) parents.add(parent);
  }
  const surfaces = new Map();
  const walks = new Map();
  await Promise.all([
    ...childFrames.map(async (frame) => {
      surfaces.set(frame, await readFrameSurface(frame));
    }),
    ...[...parents].map(async (frame) => {
      walks.set(
        frame,
        await readFrameWalk(frame, {
          frameLimit: CHALLENGE_FRAME_LIMIT,
          frameTextLimit: CHALLENGE_FRAME_TEXT_LIMIT,
          wantFrameText: false,
          walkBudgetMs: CHALLENGE_WALK_BUDGET_MS,
        }),
      );
    }),
  ]);

  const pools = new Map();
  const poolFor = (parent) => {
    if (!parent) return [];
    if (!pools.has(parent)) {
      const source =
        parent === mainFrame ? mainDescriptors : walks.get(parent)?.iframes;
      pools.set(
        parent,
        (source || []).map((entry) => ({ ...entry, used: false })),
      );
    }
    return pools.get(parent);
  };

  const presentations = new Map();
  for (const frame of childFrames) {
    presentations.set(
      frame,
      matchFrameDescriptor(frame, poolFor(frame.parentFrame())),
    );
  }
  await Promise.all(
    childFrames
      .filter((frame) => !presentations.get(frame))
      .map(async (frame) => {
        presentations.set(frame, await resolveFramePresentation(frame));
      }),
  );

  return childFrames.map((frame) => {
    const surface = surfaces.get(frame) || { text: "", checked: false };
    const presentation = presentations.get(frame) || null;
    return {
      url: frame.url(),
      text: surface.text,
      visible: presentation?.visible ?? null,
      width: presentation?.width ?? null,
      height: presentation?.height ?? null,
      completed: surface.checked || CHALLENGE_COMPLETED_TEXT.test(surface.text),
    };
  });
}

// Stage 1 always runs; stage 2 runs only when `options.gate` says so. Without a
// gate the full scan runs, which is what the captcha-solving paths need. The
// returned shape is identical either way — a skipped stage 2 reports no frames,
// exactly as a frame-free page does.
//
// The four stage-1 reads are issued together and degrade independently, so one
// slow field cannot blank the others: an empty `tokens` in particular would
// re-report a solved challenge and burn the solver's attempt budget.
export async function collectChallengeMetadata(page: Page, options: any = {}) {
  const [title, text, tokens, walk] = await Promise.all([
    page.title().catch(() => ""),
    page
      .locator("body")
      .innerText({ timeout: CHALLENGE_MAIN_TEXT_TIMEOUT_MS })
      .catch(() => ""),
    readSolvedProviders(page),
    readFrameWalk(page, {
      frameLimit: CHALLENGE_FRAME_LIMIT,
      frameTextLimit: CHALLENGE_FRAME_TEXT_LIMIT,
      // Frame text is only read when a gate will judge it; the full scan reads
      // every frame itself and would otherwise pay for the same text twice.
      wantFrameText: Boolean(options.gate),
      walkBudgetMs: CHALLENGE_WALK_BUDGET_MS,
    }),
  ]);
  const main = {
    url: page.url(),
    title,
    text: text.slice(0, CHALLENGE_MAIN_TEXT_LIMIT),
  };

  let childFrames = [];
  try {
    childFrames = page
      .frames()
      .filter((frame) => frame !== page.mainFrame())
      .slice(0, CHALLENGE_FRAME_LIMIT);
  } catch {
    // A page that closed mid-scan still reports its main-frame metadata.
  }

  const scanFrames = options.gate
    ? options.gate({ main, tokens, childFrames, sameOrigin: walk.sameOrigin })
    : true;
  const frames = scanFrames
    ? await collectFrameMetadata(page, childFrames, walk.iframes)
    : [];
  return { main, frames, solvedProviders: Object.keys(tokens), tokens };
}

export function createChallengeScanner<Session extends ChallengeSession>({
  captureScreenshot,
  pageId,
  lastBlockedDocumentAt,
}: ChallengeScanDeps<Session>) {
  // The gate itself lives in challenges.ts so it cannot drift from the detector
  // it has to agree with; this only reads the per-page state it needs.
  //
  // Each frame stage 2 would scan contributes exactly one source. Same-origin
  // frames carry the text and visibility stage 1 already read, so the gate judges
  // them on the same evidence the full scan would. Cross-origin frames carry only
  // a URL and are flagged `readable: false`, which is what makes the gate treat
  // them as unknown rather than as benign.
  function challengeScanState(session: Session, page: Page, { main, tokens, childFrames, sameOrigin }) {
    const readable = new Map();
    for (const entry of sameOrigin || []) {
      const queued = readable.get(entry.url);
      if (queued) queued.push(entry);
      else readable.set(entry.url, [entry]);
    }
    const frames = childFrames.map((frame) => {
      const entry = readable.get(frame.url())?.shift();
      return entry ? { ...entry, readable: true } : { url: frame.url(), readable: false };
    });
    // Anything the walk read that no live frame claimed is still evidence.
    for (const queued of readable.values()) {
      for (const entry of queued) frames.push({ ...entry, readable: true });
    }
    return {
      openProviders: session.openChallengeProviders,
      blockedAt: lastBlockedDocumentAt(page) || 0,
      now: Date.now(),
      main,
      frames,
      solvedProviders: Object.keys(tokens),
    };
  }

  async function detectSessionChallenges(session: Session) {
    const challenges = [];
    const activePage = session.currentId
      ? session.pages.get(session.currentId)
      : null;
    const pages =
      activePage && !activePage.isClosed()
        ? [activePage]
        : [...session.pages.values()].filter((page) => !page.isClosed()).slice(0, 1);
    let scanned = false;
    for (const page of pages) {
      if (page.isClosed()) continue;
      const metadata = await collectChallengeMetadata(page, {
        gate: (surface) => challengeScanNeeded(challengeScanState(session, page, surface)),
      });
      scanned = true;
      const challenge = detectBotChallenge(metadata);
      if (challenge) {
        const classification = classifyChallengeStage({
          ...metadata,
          provider: challenge.provider,
          type: challenge.type,
        });
        const reported: any = {
          pageId: pageId(page),
          ...challenge,
          stage: classification.stage,
          autoSolvable: classification.autoSolvable,
          needsVision: classification.needsVision,
        };
        try {
          const file = await captureScreenshot(
            page,
            session,
            "captcha-detected.png",
            "captcha-detected.png",
            { type: "png", animations: "disabled" },
          );
          const artifact = { kind: "captcha", path: file, media: `MEDIA:${file}` };
          session.artifacts.push(artifact);
          reported.artifact = artifact;
        } catch {
          // Challenge reporting must survive pages that close or cannot be captured.
        }
        challenges.push(reported);
      }
    }
    // Written only from a completed scan, and a scan that finds nothing writes an
    // empty set — so a solved or navigated-away challenge always releases the
    // gate instead of pinning every later execute on the full frame walk.
    if (scanned) {
      session.openChallengeProviders = new Set(
        challenges.map((entry) => entry.provider).filter(Boolean),
      );
    }
    return challenges;
  }

  return { detectSessionChallenges };
}

export function markChallengesForWorkerRestart(challenges) {
  return challenges.map((challenge) => ({
    ...challenge,
    solve: {
      ...challenge.solve,
      resumeOnClear: false,
      reopenRequired: true,
    },
    recovery: {
      pagePreserved: false,
      reopenUrl: challenge.url,
    },
    advice:
      "A bot challenge was visible when the browser run had to be restarted, so " +
      "this page cannot be preserved. In the next browser call, reopen the reported " +
      "URL, inspect the attached challenge image and fresh snapshot, solve up to " +
      "three distinct stages with the native CAPTCHA or human helpers, then resume " +
      "the original task. Use a host web-research tool, first-party route, or human " +
      "handoff if it remains unresolved.",
  }));
}
