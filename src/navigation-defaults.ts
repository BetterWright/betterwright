import { isRecord } from "./untrusted-value.js";

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
