import assert from "node:assert/strict";
import test from "node:test";

import { obscuraServeArgs } from "../../dist/src/obscura-runtime.js";

test("Obscura stays loopback-only and behind BetterWright's guard proxy", () => {
  assert.deepEqual(
    obscuraServeArgs({
      port: 9123,
      storageDir: "/tmp/profile",
      proxy: "http://127.0.0.1:4567",
    }),
    [
      "serve",
      "--port",
      "9123",
      "--storage-dir",
      "/tmp/profile",
      "--allow-private-network",
      "--stealth",
      "--proxy",
      "http://127.0.0.1:4567",
    ],
  );
});
