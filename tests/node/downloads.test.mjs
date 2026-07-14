import assert from "node:assert/strict";
import { test } from "node:test";

import { isUnsupportedBrowserDownloadGuard } from "../../src/downloads.mjs";

test("recognizes the attach-mode browser context limitation", () => {
  assert.equal(
    isUnsupportedBrowserDownloadGuard(
      new Error(
        "cdpSession.send: Protocol error (Browser.setDownloadBehavior): " +
          "Browser context management is not supported.",
      ),
    ),
    true,
  );
  assert.equal(
    isUnsupportedBrowserDownloadGuard(
      new Error("Protocol error (Browser.setDownloadBehavior): Not allowed"),
    ),
    false,
  );
});
