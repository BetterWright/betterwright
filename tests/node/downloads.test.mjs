import assert from "node:assert/strict";
import { test } from "node:test";

import {
  downloadBehaviorParams,
  normalizeDownloadPolicy,
} from "../../dist/src/downloads.js";

test("normalizes the three download policies", () => {
  assert.equal(normalizeDownloadPolicy(undefined), "ask");
  assert.equal(normalizeDownloadPolicy(" ALLOW "), "allow");
  assert.equal(normalizeDownloadPolicy("deny"), "deny");
  assert.throws(() => normalizeDownloadPolicy("later"), /downloadPolicy/);
});

test("download behavior is denied until an approved run enables it", () => {
  assert.deepEqual(downloadBehaviorParams(false, "/tmp/downloads"), {
    behavior: "deny",
    eventsEnabled: true,
  });
  assert.deepEqual(downloadBehaviorParams(true, "/tmp/downloads"), {
    behavior: "allowAndName",
    downloadPath: "/tmp/downloads",
    eventsEnabled: true,
  });
});
