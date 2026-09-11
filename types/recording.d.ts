export interface RecordingOptions {
  /** Defaults to recording.mp4. A .webm filename selects VP8 instead of H.264. */
  name?: string;
  /** Requested output rate, 1-60 (default 60). Output FPS is not capture cadence. */
  fps?: number;
  /** Video width bound in px (default 1280). */
  maxWidth?: number;
  /** Video height bound in px (default 720). */
  maxHeight?: number;
  /** Capture quality 1-100 (default 80). */
  quality?: number;
  /** Stop after this long (default 300000). */
  maxDurationMs?: number;
}

export interface RecordingStats {
  /** Video path inside the session artifact directory. */
  path: string;
  fps: number;
  /** Frames the capture delivered. */
  capturedFrames: number;
  /** Frames written to the video, including repeated stills. */
  outputFrames: number;
  /** Captures discarded when the encoder fell behind. */
  droppedFrames: number;
  durationMs: number;
  bytes: number;
}

/** Encoder status for a recording that has started. */
export type RecordingStatus = RecordingStats & (
  | { state: "recording" | "stopping" | "completed" }
  | { state: "failed"; error: string }
);

/** Result of the snippet helpers recording.status() and recording.stop(). */
export type SessionRecordingStatus =
  | { state: "idle" }
  | (RecordingStatus & { pageId: string });

export interface RecordingHandle {
  status(): RecordingStatus;
  stop(): Promise<RecordingStatus>;
}
