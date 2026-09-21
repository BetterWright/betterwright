import type { Page } from "playwright-core";
import {
  compressSnapshot,
  diffSnapshots,
  filterInteractive,
} from "./snapshot.js";
import type { UntrustedValue } from "./untrusted-value.js";

export const DEFAULT_SNAPSHOT_MAX_CHARS = 10_000;
export const MAX_SNAPSHOT_MAX_CHARS = 20_000;

interface WorkerSnapshotsDeps {
  trackSecret: (value: string) => void;
  pageId: (page: Page) => string;
  actionTimeoutMs: number;
}

export function createWorkerSnapshots(deps: WorkerSnapshotsDeps) {
  // Last snapshot text per page, keyed by the options that shape it, so
  // `diff: true` always compares like against like.
  const lastSnapshots = new WeakMap<Page, Map<string, string>>();

  // Replace any `<input type=password>` value with "[redacted]" in an aria
  // snapshot. The values are read in the privileged worker (never handed to the
  // sandbox) only to scrub them from the returned text and register them with the
  // redaction net; nothing about them is returned. Empty when the page has no
  // filled password field, so ordinary pages pay only one cheap evaluate.
  async function redactPasswordValues(page: Page, text: string) {
    if (!text) return text;
    let values: string[];
    try {
      const perFrame = await Promise.all(
        page.frames().map((frame) =>
          frame
            .evaluate(() => {
              const isFilledText = (value: UntrustedValue): value is string =>
                typeof value === "string" && value.length > 0;
              // SAFETY: the selector matches only password inputs, whose HTML
              // interface is HTMLInputElement; an impostor element from another
              // namespace reads `value` as undefined and fails the guard.
              return Array.from(document.querySelectorAll("input[type=password]"))
                .map((element) => (element as HTMLInputElement).value)
                .filter(isFilledText);
            })
            .catch(() => []),
        ),
      );
      values = [...new Set(perFrame.flat())];
    } catch {
      // A page mid-navigation may refuse evaluate; the snapshot still returns.
      return text;
    }
    let out = text;
    for (const value of values) {
      deps.trackSecret(value);
      out = out.split(value).join("[redacted]");
    }
    return out;
  }

  async function snapshotPage(page: Page, options: any = {}) {
    const depth = Math.floor(Number(options?.depth) || 0);
    const ref = options?.ref ? String(options.ref) : "";
    if (ref && !/^(?:f\d+)*e\d+$/.test(ref))
      throw new Error(
        `Invalid snapshot ref "${ref}" — expected a marker like "e12" or "f1e3".`,
      );
    const scope = ref
      ? page.locator(`aria-ref=${ref}`)
      : options?.selector
        ? page.locator(String(options.selector))
        : page.locator("body");
    const snapshotRequest = {
      mode: "ai" as const,
      timeout: Number(options?.timeout || deps.actionTimeoutMs),
    };
    let text = await scope.ariaSnapshot(
      depth > 0 ? { ...snapshotRequest, depth } : snapshotRequest,
    );
    // Playwright's aria snapshot includes filled input values, including
    // `<input type=password>`. Scrub those before the text is stored (for diffs),
    // truncated, or returned, so a routine read never slurps a just-typed or
    // extension-filled secret into model context.
    text = await redactPasswordValues(page, text);
    text = compressSnapshot(text, { urls: options?.urls === true });
    if (options?.interactive) text = filterInteractive(text);

    const key = JSON.stringify([
      ref,
      String(options?.selector || ""),
      Boolean(options?.interactive),
      depth,
      options?.urls === true,
    ]);

    let title = "";
    try {
      const rawTitle = await page.title();
      title = String(rawTitle)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
    } catch {
      // A page mid-navigation can refuse title(); the header works without it.
    }
    const header = `page ${deps.pageId(page)} ${page.url()}${title ? ` "${title}"` : ""}`;
    const store = lastSnapshots.get(page) || new Map<string, string>();
    lastSnapshots.set(page, store);
    const previous = store.get(key);
    const current = text;
    if (options?.diff && previous !== undefined) {
      const result = diffSnapshots(previous, text);
      if (!result.changed)
        return `${header}\n(no changes since previous snapshot)`;
      if (!result.tooLarge)
        text = `diff vs previous snapshot (+${result.additions} -${result.removals})\n${result.diff}`;
    }
    const limit = Math.max(
      1_000,
      Math.min(Number(options?.maxChars || DEFAULT_SNAPSHOT_MAX_CHARS), MAX_SNAPSHOT_MAX_CHARS),
    );
    if (text.length <= limit) {
      store.set(key, current);
      return `${header}\n${text}`;
    }
    // Refuse instead of truncating: a cut-off tree reads as complete and sends
    // the model acting on half a page, while an error steers it to a scoped
    // re-read.
    const hints = [];
    if (!options?.interactive)
      hints.push("{interactive: true} to keep only actionable elements");
    hints.push(
      options?.ref || options?.selector
        ? "a smaller {depth} or a deeper {ref}/{selector} to narrow this subtree"
        : "{ref} or {selector} to scope to one element, or {depth} to limit nesting",
    );
    if (limit < MAX_SNAPSHOT_MAX_CHARS) hints.push(`{maxChars} up to ${MAX_SNAPSHOT_MAX_CHARS}`);
    return (
      `${header}\nSnapshot is ${text.length} chars, over the ${limit} limit. ` +
      `Retry with ${hints.join(", ")}.`
    );
  }

  return {
    snapshotPage,
  };
}
