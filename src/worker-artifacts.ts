import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CDPSession,
  Page,
} from "playwright-core";
import { mkdirPrivate, writePrivateBytes } from "./fs-private.js";
import type {
  RecordingHandle,
  RecordingOptions,
  RecordingStatus,
} from "./recording.js";
import { parseAnnotationBoxes } from "./snapshot.js";
import {
  isRecord,
  isString,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";

export const MAX_TRACKED_ARTIFACTS = 500;
export const DEFAULT_ARTIFACT_QUOTA = 100 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_LIMIT = 50 * 1024 * 1024;
export const DEFAULT_SCREENSHOT_LIMIT = 10 * 1024 * 1024;
export const DEFAULT_SCREENSHOT_PIXEL_LIMIT = 40_000_000;
export const DEFAULT_RECORDING_LIMIT = 50 * 1024 * 1024;
export const DEFAULT_SCREENSHOT_TIMEOUT_MS = 15_000;

export const ANNOTATION_OVERLAY_ID = "__betterwright_annotations__";

export interface WorkerArtifactSession {
  id: string;
  pages: Map<string, Page>;
  artifacts: Array<{ kind: string; path: string; mimeType?: string }>;
  warnings: string[];
  reservedArtifactBytes: number;
}

export interface WorkerArtifactConfig {
  artifactsDir: string;
  maxArtifactBytes?: number;
  maxDownloadBytes?: number;
  maxScreenshotBytes?: number;
  maxScreenshotPixels?: number;
}

export type RecordingOwner = {
  handle: RecordingHandle;
  page: Page;
  path: string;
};

export type SessionRecording =
  | { state: "starting"; ready: Promise<RecordingOwner> }
  | { state: "active"; page: Page; path: string; ready: Promise<RecordingOwner> }
  | { state: "finished"; page: Page; path: string; result: RecordingStatus };

export interface WorkerArtifactsDeps<Session extends WorkerArtifactSession> {
  getConfig: () => WorkerArtifactConfig;
  newCDPSession: (page: Page) => Promise<CDPSession>;
  sessions: () => Iterable<Session>;
  ensureSessionPage: (session: Session) => Promise<Page>;
  pageId: (page: Page) => string;
  wakeSessionPages: (session: Session) => Promise<void>;
  quietSessionPages: (session: Session) => void;
  redactText: (value: UntrustedValue) => string;
  actionTimeoutMs: number;
}

export function createWorkerArtifacts<Session extends WorkerArtifactSession>(
  deps: WorkerArtifactsDeps<Session>,
) {
  const sessionRecordings = new Map<string, SessionRecording>();

  function configuredLimit(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function safeName(value, fallback = "artifact") {
    const base = path.basename(String(value || fallback));
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
    return (cleaned || fallback).slice(0, 160);
  }

  function uniqueName(name) {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    return `${stem}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`;
  }

  function artifactDir(session: Session) {
    const root = deps.getConfig().artifactsDir;
    const safeSession = crypto
      .createHash("sha256")
      .update(session.id)
      .digest("hex")
      .slice(0, 16);
    const dir = path.join(root, safeSession);
    mkdirPrivate(dir);
    return dir;
  }

  function downloadByteLimit() {
    const config = deps.getConfig();
    return Math.min(
      configuredLimit(config.maxDownloadBytes, DEFAULT_DOWNLOAD_LIMIT),
      configuredLimit(config.maxArtifactBytes, DEFAULT_ARTIFACT_QUOTA),
    );
  }

  function pruneArtifactQuota(session: Session, incomingBytes = 0) {
    const root = artifactDir(session);
    const limit = configuredLimit(
      deps.getConfig().maxArtifactBytes,
      DEFAULT_ARTIFACT_QUOTA,
    );
    if (incomingBytes > limit) {
      throw new Error(`Browser artifact exceeds the ${limit}-byte artifact limit.`);
    }
    let total = Number(session.reservedArtifactBytes) || 0;
    const files: Array<{ file: string; size: number; mtime: number }> = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(root, entry.name);
      const recording = sessionRecordings.get(session.id);
      if (recording?.state === "active" && recording.path === file) continue;
      const stat = fs.statSync(file);
      total += stat.size;
      files.push({ file, size: stat.size, mtime: stat.mtimeMs });
    }
    if (total + incomingBytes <= limit) return;
    files.sort((left, right) => left.mtime - right.mtime);
    for (const item of files) {
      if (total + incomingBytes <= limit) break;
      fs.rmSync(item.file, { force: true });
      total -= item.size;
      session.warnings.push(
        `Artifact quota removed ${path.basename(item.file)}.`,
      );
    }
    if (total + incomingBytes > limit) {
      throw new Error(`Browser artifact quota cannot reserve ${incomingBytes} bytes.`);
    }
  }

  function reserveArtifactQuota(session: Session, bytes) {
    pruneArtifactQuota(session, bytes);
    session.reservedArtifactBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.reservedArtifactBytes = Math.max(
        0,
        session.reservedArtifactBytes - bytes,
      );
    };
  }

  function writeBoundedArtifact(
    session: Session,
    file,
    content,
    perFileLimit,
    label,
  ) {
    if (!Buffer.isBuffer(content)) throw new Error(`${label} did not produce bytes.`);
    if (content.length > perFileLimit) {
      throw new Error(`${label} exceeds the ${perFileLimit}-byte limit.`);
    }
    pruneArtifactQuota(session, content.length);
    writePrivateBytes(file, content);
  }

  function makeArtifactPath(
    session: Session,
    requested,
    fallback = "artifact.txt",
    track = true,
  ) {
    const recordingSlots = sessionRecordings.get(session.id)?.state === "active" ? 1 : 0;
    if (session.artifacts.length + recordingSlots >= MAX_TRACKED_ARTIFACTS) {
      throw new Error(
        `Browser artifact limit (${MAX_TRACKED_ARTIFACTS}) reached for this session.`,
      );
    }
    const name = uniqueName(safeName(requested, fallback));
    const file = path.join(artifactDir(session), name);
    if (track) session.artifacts.push({ kind: "artifact", path: file });
    return file;
  }

  async function startSessionRecording(
    session: Session,
    options: RecordingOptions = {},
  ) {
    if (!isRecord(options)) {
      throw new TypeError("recording.start options must be an object.");
    }
    const requested = untrustedField(options, "name") ?? "recording.mp4";
    if (!isString(requested) || !requested.trim() ||
        requested !== path.basename(requested) || requested !== path.win32.basename(requested) ||
        !/\.(mp4|webm)$/i.test(requested)) {
      throw new TypeError("Recording name must be a .mp4 or .webm filename without directories.");
    }
    const current = sessionRecordings.get(session.id);
    if (current && current.state !== "finished") {
      throw new Error("A recording is already active in this session. Stop it or use recording.restart().");
    }
    const pending: Extract<SessionRecording, { state: "starting" }> = {
      state: "starting",
      ready: Promise.resolve().then(async () => {
        let release = () => {};
        let page: Page | undefined;
        let active: Extract<SessionRecording, { state: "active" }> | undefined;
        const onPageClosed = () => {
          void pending.ready.then(({ handle }) => handle.stop()).catch(() => {});
        };
        try {
          const { normalizeRecordingOptions, startRecording } = await import("./recording.js");
          const settings = normalizeRecordingOptions(options);
          page = await deps.ensureSessionPage(session);
          const file = makeArtifactPath(session, requested, "recording.mp4", false);
          const maxBytes = Math.max(1, Math.floor(Math.min(
            DEFAULT_RECORDING_LIMIT,
            configuredLimit(deps.getConfig().maxArtifactBytes, DEFAULT_ARTIFACT_QUOTA) / 2,
          )));
          release = reserveArtifactQuota(session, maxBytes);
          active = { state: "active", page, path: file, ready: pending.ready };
          sessionRecordings.set(session.id, active);
          page.once("close", onPageClosed);
          page.once("crash", onPageClosed);
          await deps.wakeSessionPages(session);
          const cdp = await deps.newCDPSession(page);
          const handle = await startRecording({
            cdp,
            path: file,
            options: settings,
            maxBytes,
            onStop: (result) => {
              release();
              page.off("close", onPageClosed);
              page.off("crash", onPageClosed);
              if (sessionRecordings.get(session.id) !== active) return;
              sessionRecordings.set(session.id, { state: "finished", page, path: file, result });
              if (result.state === "completed") {
                session.artifacts.push({ kind: "recording", path: file, mimeType: /\.webm$/i.test(file) ? "video/webm" : "video/mp4" });
              } else if (result.state === "failed") {
                session.warnings.push(`Recording failed: ${deps.redactText(result.error)}`);
              }
              deps.quietSessionPages(session);
            },
          });
          return { handle, page, path: file };
        } catch (error) {
          release();
          page?.off("close", onPageClosed);
          page?.off("crash", onPageClosed);
          const entry = sessionRecordings.get(session.id);
          if (entry === pending || entry === active) sessionRecordings.delete(session.id);
          throw error;
        }
      }),
    };
    sessionRecordings.set(session.id, pending);
    const { handle, page } = await pending.ready;
    return Object.assign(Object.create(null), handle.status(), { pageId: deps.pageId(page) });
  }

  async function sessionRecordingStatus(session: Session) {
    const entry = sessionRecordings.get(session.id);
    if (!entry) return Object.assign(Object.create(null), { state: "idle" });
    if (entry.state === "finished") {
      return Object.assign(Object.create(null), entry.result, { pageId: deps.pageId(entry.page) });
    }
    const { handle, page } = await entry.ready;
    return Object.assign(Object.create(null), handle.status(), { pageId: deps.pageId(page) });
  }

  async function stopSessionRecording(session: Session) {
    const entry = sessionRecordings.get(session.id);
    if (!entry) return Object.assign(Object.create(null), { state: "idle" });
    if (entry.state === "finished") {
      return Object.assign(Object.create(null), entry.result, { pageId: deps.pageId(entry.page) });
    }
    const { handle, page } = await entry.ready;
    return Object.assign(Object.create(null), await handle.stop(), { pageId: deps.pageId(page) });
  }

  async function stopPageRecording(page: Page) {
    for (const session of deps.sessions()) {
      if (![...session.pages.values()].includes(page)) continue;
      const entry = sessionRecordings.get(session.id);
      if (!entry || entry.state === "finished") continue;
      const owner = await entry.ready.catch(() => undefined);
      if (owner?.page === page) await owner.handle.stop();
    }
  }

  function sessionRecordingIsBusy(sessionId: string) {
    const recording = sessionRecordings.get(sessionId);
    return recording?.state === "starting" || recording?.state === "active";
  }

  function pageRecordingIsBusy(sessionId: string, page: Page) {
    const recording = sessionRecordings.get(sessionId);
    return recording?.state === "starting" ||
      (recording?.state === "active" && recording.page === page);
  }

  async function assertScreenshotPixelLimit(page: Page, options) {
    const scale = options.scale === "css"
      ? 1
      : await page
          .evaluate(() => window.devicePixelRatio || 1)
          .catch(() => 1);
    const metrics = options.clip
      ? {
          width: Number(options.clip.width),
          height: Number(options.clip.height),
        }
      : options.fullPage
        ? await page.evaluate(() => ({
            width: Math.max(
              document.documentElement.scrollWidth,
              document.body?.scrollWidth || 0,
            ),
            height: Math.max(
              document.documentElement.scrollHeight,
              document.body?.scrollHeight || 0,
            ),
          }))
        : page.viewportSize() || { width: 1440, height: 900 };
    const pixels =
      Math.ceil(metrics.width * scale) * Math.ceil(metrics.height * scale);
    const limit = configuredLimit(
      deps.getConfig().maxScreenshotPixels,
      DEFAULT_SCREENSHOT_PIXEL_LIMIT,
    );
    if (!Number.isFinite(pixels) || pixels <= 0 || pixels > limit) {
      throw new Error(`Screenshot pixel limit (${limit}) exceeded.`);
    }
  }

  function drawAnnotationOverlay({ boxes, fullPage, overlayId }) {
    document.getElementById(overlayId)?.remove();
    const root = document.createElement("div");
    root.id = overlayId;
    const dx = fullPage ? window.scrollX : 0;
    const dy = fullPage ? window.scrollY : 0;
    root.style.cssText =
      `position:${fullPage ? "absolute" : "fixed"};left:0;top:0;width:0;` +
      "height:0;z-index:2147483647;pointer-events:none;";
    for (const box of boxes) {
      const frame = document.createElement("div");
      frame.style.cssText =
        `position:absolute;left:${box.x + dx}px;top:${box.y + dy}px;` +
        `width:${box.width}px;height:${box.height}px;` +
        "border:2px solid #e11d48;border-radius:2px;box-sizing:border-box;";
      const label = document.createElement("span");
      label.textContent = box.ref;
      label.style.cssText =
        `position:absolute;left:-2px;top:${box.y + dy < 16 ? 0 : -16}px;` +
        "background:#e11d48;color:#fff;font:11px/14px monospace;" +
        "padding:0 3px;border-radius:2px;white-space:nowrap;";
      frame.appendChild(label);
      root.appendChild(frame);
    }
    document.body.appendChild(root);
  }

  function removeAnnotationOverlay(overlayId) {
    document.getElementById(overlayId)?.remove();
  }

  async function addScreenshotAnnotations(page: Page, fullPage) {
    const tree = await page.locator("body").ariaSnapshot({
      mode: "ai",
      boxes: true,
      timeout: deps.actionTimeoutMs,
    });
    let boxes = parseAnnotationBoxes(tree);
    if (!fullPage) {
      const viewport = page.viewportSize();
      if (viewport)
        boxes = boxes.filter(
          (box) =>
            box.x < viewport.width &&
            box.y < viewport.height &&
            box.x + box.width > 0 &&
            box.y + box.height > 0,
        );
    }
    await page.evaluate(drawAnnotationOverlay, {
      boxes,
      fullPage: Boolean(fullPage),
      overlayId: ANNOTATION_OVERLAY_ID,
    });
    return boxes.length;
  }

  async function removeScreenshotAnnotations(page: Page) {
    await page.evaluate(removeAnnotationOverlay, ANNOTATION_OVERLAY_ID).catch(() => {});
  }

  async function writeScreenshotBytes(
    session: Session,
    requested,
    fallback,
    content,
  ) {
    const perFileLimit = configuredLimit(
      deps.getConfig().maxScreenshotBytes,
      DEFAULT_SCREENSHOT_LIMIT,
    );
    if (content.length > perFileLimit) {
      throw new Error(`Screenshot exceeds the ${perFileLimit}-byte limit.`);
    }
    const file = makeArtifactPath(session, requested, fallback, false);
    writeBoundedArtifact(session, file, content, perFileLimit, "Screenshot");
    return file;
  }

  async function cssScreenshotClip(page: Page, options) {
    if (options?.clip) {
      return {
        x: Math.max(0, Number(options.clip.x) || 0),
        y: Math.max(0, Number(options.clip.y) || 0),
        width: Math.max(1, Number(options.clip.width) || 1),
        height: Math.max(1, Number(options.clip.height) || 1),
        scale: 1,
      };
    }
    if (options?.fullPage) {
      const size = await page.evaluate(() => ({
        width: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth || 0,
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight || 0,
        ),
      }));
      return {
        x: 0,
        y: 0,
        width: Math.max(1, Number(size.width) || 1),
        height: Math.max(1, Number(size.height) || 1),
        scale: 1,
      };
    }
    const viewport = page.viewportSize() || { width: 1440, height: 900 };
    return {
      x: 0,
      y: 0,
      width: Math.max(1, Number(viewport.width) || 1),
      height: Math.max(1, Number(viewport.height) || 1),
      scale: 1,
    };
  }

  async function captureScreenshotViaCdp(
    page: Page,
    session: Session,
    requested,
    fallback,
    options,
  ) {
    const cdp = await page.context().newCDPSession(page);
    try {
      const format: "jpeg" | "png" = options?.type === "jpeg" ? "jpeg" : "png";
      const params = {
        format,
        fromSurface: true,
        captureBeyondViewport: Boolean(options?.fullPage) && !options?.clip,
        clip: await cssScreenshotClip(page, options),
      };
      const shot = await cdp.send(
        "Page.captureScreenshot",
        format === "jpeg"
          ? { ...params, quality: Number(options?.quality) || 80 }
          : params,
      );
      const content = Buffer.from(String(shot?.data || ""), "base64");
      if (!content.length) throw new Error("CDP screenshot returned no bytes.");
      return writeScreenshotBytes(session, requested, fallback, content);
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  async function captureScreenshot(
    page: Page,
    session: Session,
    requested,
    fallback,
    options,
  ) {
    // Preserve the browser-visible devicePixelRatio, screen geometry, rendering
    // surface and WebGPU identity while encoding proof artifacts at one output
    // pixel per CSS pixel. The captured macOS profile uses DPR 2, so device-scale
    // output quadrupled screenshot surface area without adding useful evidence.
    // `scale: "css"` affects only the trusted artifact encoder; page APIs and
    // layout remain identical.
    const screenshotOptions = {
      scale: "css",
      timeout: DEFAULT_SCREENSHOT_TIMEOUT_MS,
      ...options,
    };
    await assertScreenshotPixelLimit(page, screenshotOptions);
    try {
      const content = await page.screenshot(screenshotOptions);
      return writeScreenshotBytes(session, requested, fallback, content);
    } catch {
      // hCaptcha and similar widgets often leave `document.fonts` pending;
      // CDP captures the current surface without that wait.
      try {
        return await captureScreenshotViaCdp(
          page,
          session,
          requested,
          fallback,
          screenshotOptions,
        );
      } catch {
        if (!screenshotOptions.clip) throw new Error("Screenshot capture failed.");
        const uncropped = { ...screenshotOptions };
        delete uncropped.clip;
        return captureScreenshotViaCdp(
          page,
          session,
          requested,
          fallback,
          uncropped,
        );
      }
    }
  }

  return {
    sessionRecordings,
    artifactDir,
    configuredLimit,
    downloadByteLimit,
    pruneArtifactQuota,
    reserveArtifactQuota,
    writeBoundedArtifact,
    makeArtifactPath,
    startSessionRecording,
    sessionRecordingStatus,
    stopSessionRecording,
    stopPageRecording,
    sessionRecordingIsBusy,
    pageRecordingIsBusy,
    addScreenshotAnnotations,
    removeAnnotationOverlay,
    removeScreenshotAnnotations,
    captureScreenshot,
  };
}
