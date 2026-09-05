import { spawn } from "node:child_process";
import fs from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CDPSession } from "playwright-core";
import type {
  RecordingHandle,
  RecordingOptions,
  RecordingStatus,
} from "../types/recording.js";
import { isRecord, isString, type UntrustedValue } from "./untrusted-value.js";

export type { RecordingHandle, RecordingOptions, RecordingStatus };

const FRAME_BYTES_LIMIT = 8 * 1024 * 1024;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
const CDP_TIMEOUT_MS = 1_000;

function integer(value: number | undefined, fallback: number, min: number, max: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`Recording ${name} must be an integer from ${min} to ${max}.`);
  }
  return resolved;
}

export function normalizeRecordingOptions(options: RecordingOptions = {}) {
  if (!isRecord(options)) throw new Error("Recording options must be an object.");
  const maxWidth = integer(options.maxWidth, 1280, 2, 4096, "maxWidth");
  const maxHeight = integer(options.maxHeight, 720, 2, 4096, "maxHeight");
  if (maxWidth * maxHeight > 8_294_400) {
    throw new Error("Recording dimensions exceed the 8294400-pixel limit.");
  }
  return {
    fps: integer(options.fps, 60, 1, 60, "fps"),
    maxWidth: maxWidth - maxWidth % 2,
    maxHeight: maxHeight - maxHeight % 2,
    quality: integer(options.quality, 80, 1, 100, "quality"),
    maxDurationMs: integer(options.maxDurationMs, 300_000, 1, 3_600_000, "maxDurationMs"),
  };
}

function bounded<T>(promise: Promise<T>, timeout: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

function errorMessage(error: UntrustedValue) {
  return error instanceof Error ? error.message : String(error);
}

export async function startRecording({
  cdp,
  path,
  options = {},
  maxBytes,
  onStop,
}: {
  cdp: Pick<CDPSession, "send" | "on" | "off" | "detach">;
  path: string;
  options?: RecordingOptions;
  maxBytes: number;
  onStop?: (status: RecordingStatus) => void;
}): Promise<RecordingHandle> {
  let config: ReturnType<typeof normalizeRecordingOptions>;
  let descriptor: number;
  try {
    config = normalizeRecordingOptions(options);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Recording maxBytes must be a positive safe integer.");
    }
    descriptor = fs.openSync(path, "wx", 0o600);
  } catch (error) {
    await bounded(cdp.detach(), CDP_TIMEOUT_MS, "Recording CDP detach timed out.").catch(() => {});
    throw error;
  }

  let lifecycle: "recording" | "stopping" | "completed" | "failed" = "recording";
  let failure = "";
  let capturedFrames = 0;
  let outputFrames = 0;
  let droppedFrames = 0;
  let bytes = 0;
  let started = 0;
  let ended = 0;
  type Frame = { data: Buffer; at: number };
  const frames: Frame[] = [];
  let frameBytes = 0;
  let lastFrame: Frame | null = null;
  let firstTimestamp: number | null = null;
  let stderr = "";
  let stopPromise: Promise<RecordingStatus> | null = null;
  let writer: Promise<void> | null = null;
  let tick: ReturnType<typeof setTimeout>;
  let durationTimer: ReturnType<typeof setTimeout>;
  let firstFrameResolve: () => void;
  let firstFrameReject: (error: Error) => void;
  const firstFrame = new Promise<void>((resolve, reject) => {
    firstFrameResolve = resolve;
    firstFrameReject = reject;
  });
  void firstFrame.catch(() => {});

  const destination = fs.createWriteStream(path, { fd: descriptor, autoClose: true });
  const encoderOptions = /\.webm$/i.test(path)
    ? ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "2M", "-f", "webm"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "28",
      "-pix_fmt", "yuv420p", "-g", String(config.fps),
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"];
  const encoder = spawn(process.env.BETTERWRIGHT_FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-filter_threads", "1",
    "-fpsprobesize", "0", "-probesize", "32", "-analyzeduration", "0",
    "-f", "image2pipe", "-framerate", String(config.fps), "-c:v", "mjpeg", "-threads", "1", "-i", "pipe:0",
    "-an", "-threads", "2", "-r", String(config.fps),
    "-vf", `scale=w='min(iw,${config.maxWidth})':h='min(ih,${config.maxHeight})':force_original_aspect_ratio=decrease,pad=${config.maxWidth}:${config.maxHeight}:(ow-iw)/2:(oh-ih)/2`,
    ...encoderOptions, "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const encoderReady = new Promise<void>((resolve, reject) => {
    encoder.once("spawn", resolve);
    encoder.once("error", reject);
  });
  void encoderReady.catch(() => {});

  const encoderDone = new Promise<void>((resolve) => {
    encoder.once("close", (code) => {
      if (code !== 0) fail(`Recording encoder exited with code ${code}${stderr ? `: ${stderr}` : "."}`);
      else if (lifecycle === "recording") fail("Recording encoder stopped unexpectedly.");
      resolve();
    });
  });
  encoder.on("error", (error) => {
    fail(`Cannot run FFmpeg. Install FFmpeg or set BETTERWRIGHT_FFMPEG_PATH. ${error.message}`);
  });
  encoder.stderr.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString("utf8")).slice(-4096);
  });
  encoder.stdin.on("error", (error) => fail(`Recording encoder input failed. ${error.message}`));
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (bytes + chunk.length > maxBytes) {
        callback(new Error(`Recording exceeds the ${maxBytes}-byte limit.`));
        return;
      }
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  const outputDone = pipeline(encoder.stdout, limiter, destination).catch(error => {
    fail(errorMessage(error));
  });

  function status(): RecordingStatus {
    const stats = {
      path, fps: config.fps, capturedFrames, outputFrames, droppedFrames,
      durationMs: started ? Math.max(0, (ended || performance.now()) - started) : 0,
      bytes,
    };
    return lifecycle === "failed"
      ? { ...stats, state: "failed", error: failure }
      : { ...stats, state: lifecycle };
  }

  function fail(message: string) {
    if (lifecycle === "completed" || lifecycle === "failed") return;
    failure ||= message;
    firstFrameReject(new Error(failure));
    void stop();
  }

  function waitForDrain() {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        encoder.stdin.off("drain", drained);
        encoder.stdin.off("error", rejected);
        encoder.stdin.off("close", closed);
      };
      const drained = () => { cleanup(); resolve(); };
      const rejected = (error: Error) => { cleanup(); reject(error); };
      const closed = () => rejected(new Error("Recording encoder input closed before draining."));
      encoder.stdin.once("drain", drained);
      encoder.stdin.once("error", rejected);
      encoder.stdin.once("close", closed);
      if (encoder.stdin.destroyed) closed();
    });
  }

  async function writeUntil(target: number) {
    while (!failure && (frames.length || lastFrame) && outputFrames < target) {
      const at = outputFrames * 1000 / config.fps;
      let frame = lastFrame;
      let distance = frame ? Math.abs(frame.at - at) : Infinity;
      let selected = -1;
      for (let index = 0; index < frames.length; index++) {
        const nextDistance = Math.abs(frames[index].at - at);
        if (nextDistance < distance) {
          frame = frames[index];
          distance = nextDistance;
          selected = index;
        }
      }
      if (!frame) return;
      if (selected >= 0) {
        for (const consumed of frames.splice(0, selected + 1)) frameBytes -= consumed.data.length;
        droppedFrames += selected;
      }
      lastFrame = frame;
      const accepted = encoder.stdin.write(frame.data);
      outputFrames += 1;
      if (!accepted) await waitForDrain();
    }
  }

  function schedule() {
    if (lifecycle !== "recording" || !started || writer) return;
    const next = started + (outputFrames + 2) * 1000 / config.fps;
    tick = setTimeout(() => {
      const target = Math.max(0, 1 + Math.floor((performance.now() - started) * config.fps / 1000 - 2));
      writer = writeUntil(target).catch(error => fail(errorMessage(error))).finally(() => {
        writer = null;
        schedule();
      });
    }, Math.max(1, next - performance.now()));
  }

  const frameListener = (event) => {
    if (lifecycle !== "recording") return;
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(error => fail(errorMessage(error)));
    if (!isString(event.data) || event.data.length > Math.ceil(FRAME_BYTES_LIMIT * 4 / 3)) {
      fail("Recording frame exceeds the 8388608-byte limit or is invalid.");
      return;
    }
    const data = Buffer.from(event.data, "base64");
    if (!data.length || data.length > FRAME_BYTES_LIMIT) {
      fail("Recording received an empty or oversized frame.");
      return;
    }
    capturedFrames += 1;
    const timestamp = event.metadata?.timestamp;
    if (firstTimestamp === null && Number.isFinite(timestamp)) firstTimestamp = timestamp;
    const at = Number.isFinite(timestamp) && firstTimestamp !== null
      ? Math.max(0, (timestamp - firstTimestamp) * 1000)
      : started ? performance.now() - started : 0;
    frames.push({ data, at });
    frameBytes += data.length;
    while (frames.length > 4 || frameBytes > FRAME_BYTES_LIMIT * 2) {
      frameBytes -= frames.shift().data.length;
      droppedFrames += 1;
    }
    if (!started) {
      started = performance.now();
      durationTimer = setTimeout(() => { void stop(); }, config.maxDurationMs);
      firstFrameResolve();
      schedule();
    }
  };
  const detachedListener = () => fail("Recording page or CDP session closed.");
  cdp.on("Page.screencastFrame", frameListener);
  cdp.on("close", detachedListener);

  async function finish() {
    clearTimeout(tick);
    clearTimeout(durationTimer);
    cdp.off("Page.screencastFrame", frameListener);
    cdp.off("close", detachedListener);
    ended = performance.now();
    try {
      await bounded(cdp.send("Page.stopScreencast"), CDP_TIMEOUT_MS, "Recording capture stop timed out.");
    } catch (error) { failure ||= errorMessage(error); }
    const finalize = async () => {
      if (failure) encoder.kill();
      await writer;
      if (!failure && started) await writeUntil(Math.max(1, Math.ceil((ended - started) * config.fps / 1000)));
      encoder.stdin.end();
      await Promise.all([encoderDone, outputDone]);
    };
    try {
      await bounded(finalize(), STOP_TIMEOUT_MS, "Recording encoder stop timed out.");
    } catch (error) {
      failure ||= errorMessage(error);
      encoder.kill("SIGKILL");
      encoder.stdin.destroy();
      encoder.stdout.destroy();
      destination.destroy();
      await bounded(Promise.all([encoderDone, outputDone]), CDP_TIMEOUT_MS, "Recording cleanup timed out.").catch(() => {});
    }
    await bounded(cdp.detach(), CDP_TIMEOUT_MS, "Recording CDP detach timed out.").catch(() => {});
    droppedFrames += frames.length;
    frames.length = 0;
    frameBytes = 0;
    lastFrame = null;
    if (!outputFrames) failure ||= "Recording ended before receiving a frame.";
    if (!bytes) failure ||= "Recording encoder produced no video bytes.";
    if (failure) {
      lifecycle = "failed";
      try { fs.unlinkSync(path); } catch { /* The file may already be gone. */ }
    } else lifecycle = "completed";
    const finalStatus = status();
    try { onStop?.(finalStatus); } catch {}
    return finalStatus;
  }

  function stop(): Promise<RecordingStatus> {
    if (stopPromise) return stopPromise;
    lifecycle = "stopping";
    stopPromise = finish();
    return stopPromise;
  }

  try {
    await bounded((async () => {
      await encoderReady;
      await cdp.send("Page.startScreencast", {
        format: "jpeg", quality: config.quality,
        maxWidth: config.maxWidth, maxHeight: config.maxHeight, everyNthFrame: 1,
      });
      await firstFrame;
    })(), START_TIMEOUT_MS, "Recording start timed out after 10000ms.");
    if (failure) throw new Error(failure);
    return { status, stop };
  } catch (error) {
    failure ||= errorMessage(error);
    await stop();
    throw new Error(failure);
  }
}
