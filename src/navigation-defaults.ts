import { isRecord, isString, untrustedField } from "./untrusted-value.js";

// Agent navigation needs a usable document, not every third-party subresource.
// Keep explicit Playwright options (including invalid ones) for Playwright to validate.
export function navigationOptions(options?: any): any {
  if (options !== undefined && !isRecord(options) && !Array.isArray(options)) return options;
  return { ...options, waitUntil: options?.waitUntil === undefined ? "domcontentloaded" : options.waitUntil };
}

export function applyNavigationDefaults(kind: string, method: string, args: any[]): void {
  if ((kind === "Page" || kind === "Frame") && method === "goto") {
    args[1] = navigationOptions(args[1]);
  } else if (kind === "Page" && ["reload", "goBack", "goForward"].includes(method)) {
    args[0] = navigationOptions(args[0]);
  }
}

export async function navigateHistory(page: any, method: "goBack" | "goForward", options: any, defaultTimeoutMs: number) {
  const waitUntil = untrustedField(options, "waitUntil");
  if (!isRecord(options) || !isString(waitUntil) || !["domcontentloaded", "load"].includes(waitUntil)) {
    return page[method](options);
  }
  const started = performance.now();
  const response = await page[method]({ ...options, waitUntil: "commit" });
  const timeout = Number(untrustedField(options, "timeout") ?? defaultTimeoutMs);
  const remaining = timeout === 0 ? 0 : Math.max(1, timeout - (performance.now() - started));
  const ready = await page.waitForFunction(
    (waitUntil) => {
      const navigation = performance.getEntriesByType("navigation")[0];
      if (navigation instanceof PerformanceNavigationTiming) {
        return waitUntil === "load"
          ? navigation.loadEventEnd > 0
          : navigation.domContentLoadedEventEnd > 0;
      }
      return document.readyState === "complete";
    },
    waitUntil,
    { timeout: remaining },
  );
  await ready.dispose();
  return response;
}
