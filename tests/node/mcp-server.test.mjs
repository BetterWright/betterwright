import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contentForResult,
  downloadPolicyFromEnv,
  headlessFromEnv,
  policyFromEnv,
} from "../../src/mcp-server.mjs";

test("policyFromEnv is open by default and hardens via BLOCK_* vars", () => {
  const open = policyFromEnv({});
  assert.equal(open.allowLoopback, true);
  assert.equal(open.allowPrivateNetwork, true);

  const hardened = policyFromEnv({
    BETTERWRIGHT_BLOCK_LOOPBACK: "1",
    BETTERWRIGHT_BLOCK_PRIVATE_NETWORK: "1",
    BETTERWRIGHT_ALLOW_HOSTS: "a.com, b.com,,",
    BETTERWRIGHT_BLOCK_HOSTS: "ads.com",
  });
  assert.equal(hardened.allowLoopback, false);
  assert.equal(hardened.allowPrivateNetwork, false);
  assert.deepEqual(hardened.allowHosts, ["a.com", "b.com"]);
  assert.deepEqual(hardened.blockHosts, ["ads.com"]);
});

test("downloadPolicyFromEnv defaults to ask and rejects junk", () => {
  assert.equal(downloadPolicyFromEnv({}), "ask");
  assert.equal(downloadPolicyFromEnv({ BETTERWRIGHT_DOWNLOAD_POLICY: "Allow" }), "allow");
  assert.throws(
    () => downloadPolicyFromEnv({ BETTERWRIGHT_DOWNLOAD_POLICY: "sometimes" }),
    /must be "ask", "allow", or "deny"/,
  );
});

test("headlessFromEnv defaults to auto and honors explicit values", () => {
  assert.equal(headlessFromEnv({}), "auto");
  assert.equal(headlessFromEnv({ BETTERWRIGHT_HEADLESS: "0" }), false);
  assert.equal(headlessFromEnv({ BETTERWRIGHT_HEADLESS: "true" }), true);
});

test("contentForResult separates screenshots from file paths", async () => {
  const shot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bw-mcp-")), "proof.png");
  fs.writeFileSync(shot, Buffer.from("89504e470d0a1a0a", "hex"));
  const content = await contentForResult({
    ok: true,
    result: "Example Domain",
    console: ["hello"],
    artifacts: [
      { kind: "proof", path: shot, media: `MEDIA:${shot}` },
      { kind: "download", path: "/tmp/report.pdf" },
    ],
    pages: [{ url: "https://example.com" }],
    challenges: [],
    warnings: [],
    durationMs: 12.3,
  });

  assert.equal(content[0].type, "text");
  const summary = JSON.parse(content[0].text);
  assert.deepEqual(Object.keys(summary), [
    "ok",
    "result",
    "error",
    "console",
    "files",
    "pages",
    "challenges",
    "warnings",
    "duration_ms",
  ]);
  assert.equal(summary.ok, true);
  assert.equal(summary.duration_ms, 12.3);
  assert.deepEqual(summary.files, [{ kind: "download", path: "/tmp/report.pdf" }]);
  assert.equal(content[1].type, "image");
  assert.equal(content[1].mimeType, "image/png");
});
