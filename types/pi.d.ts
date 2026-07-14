export interface BetterWrightArtifactLike {
  kind?: unknown;
  media?: unknown;
  path?: unknown;
  [key: string]: unknown;
}

export interface BetterWrightResultLike {
  artifacts?: readonly BetterWrightArtifactLike[];
  [key: string]: unknown;
}

export interface PiImageContentOptions {
  maxImageBytes?: number;
}

export interface PiImageContentBlock {
  type: "image";
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export function piImageContent(
  result: BetterWrightResultLike | null | undefined,
  options?: PiImageContentOptions,
): Promise<PiImageContentBlock[]>;
