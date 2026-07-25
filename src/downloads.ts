const DOWNLOAD_POLICIES = new Set(["ask", "allow", "deny"]);

export function normalizeDownloadPolicy(value): "ask" | "allow" | "deny" {
  const policy = String(value || "ask")
    .trim()
    .toLowerCase();
  if (!DOWNLOAD_POLICIES.has(policy)) {
    throw new TypeError(
      `downloadPolicy must be "ask", "allow", or "deny"; received ${JSON.stringify(value)}`,
    );
  }
  return policy as "ask" | "allow" | "deny";
}

export function downloadBehaviorParams(allowed, downloadPath) {
  return allowed
    ? {
        // Playwright's Download object tracks the browser-assigned GUID. Keep
        // that filename so download.path() and saveAs() address the same file.
        behavior: "allowAndName",
        downloadPath,
        eventsEnabled: true,
      }
    : { behavior: "deny", eventsEnabled: true };
}
