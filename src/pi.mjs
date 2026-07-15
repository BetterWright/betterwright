import fs from "node:fs/promises";
import path from "node:path";

const SCREENSHOT_KINDS = new Set([
  "proof",
  "question",
  "debug",
  "screenshot",
  "captcha",
]);
const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function artifactImagePath(artifact) {
  const media = String(artifact?.media || "");
  const candidate = media.startsWith("MEDIA:")
    ? media.slice("MEDIA:".length)
    : String(artifact?.path || "");
  const mimeType = IMAGE_MIME_TYPES.get(path.extname(candidate).toLowerCase());
  if (!path.isAbsolute(candidate) || !mimeType) return null;
  const kind = String(artifact?.kind || "");
  if (!SCREENSHOT_KINDS.has(kind) && !media.startsWith("MEDIA:")) return null;
  return { path: candidate, mimeType, kind };
}

/** Return safe, local image artifacts that Pi can receive as vision input. */
export function piImageArtifacts(result) {
  const images = [];
  const seen = new Set();
  for (const artifact of result?.artifacts || []) {
    const image = artifactImagePath(artifact);
    if (!image || seen.has(image.path)) continue;
    seen.add(image.path);
    images.push({ path: image.path, mimeType: image.mimeType });
  }
  return images;
}

/** Select the screenshot that best represents the browser step in a trace. */
export function piPrimaryImageArtifact(result) {
  const images = [];
  const seen = new Set();
  for (const artifact of result?.artifacts || []) {
    const image = artifactImagePath(artifact);
    if (!image || seen.has(image.path)) continue;
    seen.add(image.path);
    images.push(image);
  }
  const selected = images.findLast((image) => image.kind !== "captcha") || images.at(-1);
  return selected ? { path: selected.path, mimeType: selected.mimeType } : null;
}

/** Convert BetterWright screenshot artifacts to Pi AgentToolResult image blocks. */
export async function piImageContent(result, { maxImageBytes = 2_500_000 } = {}) {
  const content = [];
  for (const image of piImageArtifacts(result)) {
    try {
      const stat = await fs.stat(image.path);
      if (!stat.isFile() || stat.size > maxImageBytes) continue;
      const data = (await fs.readFile(image.path)).toString("base64");
      content.push({ type: "image", data, mimeType: image.mimeType });
    } catch {
      // A deleted or unreadable screenshot should not fail the browser result.
    }
  }
  return content;
}
