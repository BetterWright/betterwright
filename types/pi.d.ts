import type { UntrustedValue } from "./untrusted-value.js";

/**
 * A result artifact from any browser call, shaped loosely enough to accept
 * both the client's own `BetterWrightArtifact` and a deserialized envelope
 * from another host. Only `kind` and `media`/`path` matter to the helpers.
 */
export interface BetterWrightArtifactLike {
  kind?: UntrustedValue;
  media?: UntrustedValue;
  path?: UntrustedValue;
  [key: string]: UntrustedValue;
}

/** A browser run envelope that may carry artifacts. */
export interface BetterWrightResultLike {
  artifacts?: readonly BetterWrightArtifactLike[];
  [key: string]: UntrustedValue;
}

export interface PiImageContentOptions {
  /**
   * Per-image byte ceiling. Images above it are skipped rather than
   * downscaled. Defaults to 2,500,000 bytes.
   */
  maxImageBytes?: number;
}

/** An image content block in the shape Pi tool results expect. */
export interface PiImageContentBlock {
  type: "image";
  /** Base64 image bytes. */
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

/** An artifact that points at an image file on disk. */
export interface PiImageArtifact {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

/**
 * Image artifacts in a result that are safe to hand to a vision model:
 * `MEDIA:`-tagged files and screenshot kinds (proof, question, debug,
 * screenshot, captcha), deduplicated by path.
 */
export function piImageArtifacts(
  result: BetterWrightResultLike | null | undefined,
): PiImageArtifact[];

/** Read those image files and return them as Pi image content blocks. */
export function piImageContent(
  result: BetterWrightResultLike | null | undefined,
  options?: PiImageContentOptions,
): Promise<PiImageContentBlock[]>;

/**
 * The screenshot that best represents the step in a trace: the last
 * non-captcha image, or the last image when only captcha shots exist.
 */
export function piPrimaryImageArtifact(
  result: BetterWrightResultLike | null | undefined,
): PiImageArtifact | null;
