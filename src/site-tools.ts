import { isRecord } from "./untrusted-value.js";

export const SITE_RESPONSE_LIMIT = 1_000_000;
export const SITE_EXCERPT_LIMIT = 20_000;

const SITE_FORBIDDEN_HEADERS = new Set([
  "authorization",
  "content-length",
  "cookie",
  "host",
  "origin",
  "proxy-authorization",
  "referer",
  "sec-websocket-key",
]);

export function sameOriginSiteUrl(currentUrl, value) {
  let target;
  let current;
  try {
    current = new URL(String(currentUrl || ""));
    target = new URL(String(value || ""), current);
  } catch {
    throw new Error("site URL must be a valid HTTP(S) URL or relative path.");
  }
  if (!/^https?:$/.test(target.protocol) || target.origin !== current.origin) {
    throw new Error("site helpers only access the active page's origin.");
  }
  return target.href;
}

export function pixePuzzleNavigationUrl(currentUrl, puzzleKey) {
  let current;
  try {
    current = new URL(String(currentUrl || ""));
  } catch {
    return "";
  }
  const key = String(puzzleKey || "");
  const validKey = /^L[1-9]\d{0,5}$/.test(key) ||
    (/^D\d{4}-\d{2}-\d{2}$/.test(key) &&
      !Number.isNaN(Date.parse(key.slice(1))));
  if (
    current.hostname !== "pixe.frgmt.xyz" ||
    current.pathname !== "/" ||
    !validKey
  ) {
    return "";
  }
  return new URL(`/play/${key}`, current).href;
}

export function normalizeSiteHeaders(value) {
  if (!isRecord(value)) return {};
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = String(rawName).trim().toLowerCase();
    if (!name || SITE_FORBIDDEN_HEADERS.has(name) || name.startsWith("sec-")) {
      throw new Error(`site.request cannot set the ${rawName} header.`);
    }
    const headerValue = String(rawValue);
    if (headerValue.length > 4_096) {
      throw new Error(`site.request header ${rawName} is too large.`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

export function siteTextExcerpts(
  text,
  find,
  contextChars = 600,
  maxMatches = 12,
) {
  const needle = String(find || "");
  if (!needle) return String(text).slice(0, SITE_EXCERPT_LIMIT);
  if (needle.length > 500) throw new Error("site.read find text is too long.");
  const source = String(text);
  const context = Math.max(40, Math.min(4_000, Number(contextChars) || 600));
  const limit = Math.max(1, Math.min(50, Number(maxMatches) || 12));
  const matches = [];
  let from = 0;
  while (matches.length < limit) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    matches.push({
      index,
      text: source.slice(
        Math.max(0, index - context),
        index + needle.length + context,
      ),
    });
    from = index + Math.max(needle.length, 1);
  }
  return matches;
}
