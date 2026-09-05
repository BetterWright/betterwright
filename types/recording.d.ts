export interface RecordingOptions {
  /** Defaults to recording.mp4. A .webm filename selects VP8 instead of H.264. */
  name?: string;
  fps?: number;
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  maxDurationMs?: number;
}

export interface RecordingStats {
  path: string;
  fps: number;
  capturedFrames: number;
  outputFrames: number;
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
