export function isUnsupportedBrowserDownloadGuard(error) {
  return /browser context management is not supported/i.test(
    String(error?.message || error || ""),
  );
}
