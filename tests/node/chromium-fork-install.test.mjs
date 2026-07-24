import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  BETTERWRIGHT_CHROMIUM_VERSION,
  CHROMIUM_FORK_ASSETS,
  CHROMIUM_FORK_RELEASE_TAG,
} from "../../src/chromium-fork.mjs";
import {
  chromiumForkAssetForHost,
  installChromiumFork,
} from "../../src/chromium-fork-install.mjs";
import { makeTempDir } from "./helpers/temp-dir.mjs";

test("public fork assets are pinned for mac-arm64 and linux-x64", () => {
  assert.equal(CHROMIUM_FORK_RELEASE_TAG, `chromium-${BETTERWRIGHT_CHROMIUM_VERSION}`);
  assert.equal(
    chromiumForkAssetForHost({ platform: "darwin", arch: "arm64" })?.name,
    "betterwright-chromium-mac-arm64.zip",
  );
  assert.equal(
    chromiumForkAssetForHost({ platform: "linux", arch: "x64" })?.name,
    "betterwright-chromium-linux-x64.zip",
  );
  assert.equal(chromiumForkAssetForHost({ platform: "win32", arch: "x64" }), null);
  for (const asset of Object.values(CHROMIUM_FORK_ASSETS)) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
});

test("installChromiumFork skips platforms without a public artifact", async () => {
  const result = await installChromiumFork({
    platform: "win32",
    arch: "x64",
    home: "/tmp/bw-home",
    log() {},
  });
  assert.match(result.skipped, /No public Chromium fork artifact/);
  assert.equal(result.binary, null);
});

test("installChromiumFork short-circuits when already installed", async () => {
  const home = "/home/deploy";
  const binary = path.join(home, ".betterwright", "chromium", "linux-x64", "chrome");
  const logs = [];
  const result = await installChromiumFork({
    platform: "linux",
    arch: "x64",
    home,
    force: false,
    existsSync: (p) => p === binary,
    log: (line) => logs.push(String(line)),
    download: async () => {
      throw new Error("should not download");
    },
  });
  assert.equal(result.alreadyInstalled, true);
  assert.equal(result.binary, binary);
  assert.match(logs.join("\n"), /already installed/);
});

test("installChromiumFork downloads, verifies SHA-256, and extracts", async () => {
  const home = makeTempDir("bw-fork-home-");
  const payload = Buffer.from("betterwright-chromium-test-zip");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const assets = {
    "linux-x64": { name: "test-linux.zip", sha256 },
  };
  const binaryRel = path.join("linux-x64", "chrome");
  let downloadedUrl = null;

  try {
    const result = await installChromiumFork({
      platform: "linux",
      arch: "x64",
      home,
      force: true,
      assets,
      log() {},
      download: async (url, dest) => {
        downloadedUrl = url;
        fs.writeFileSync(dest, payload);
      },
      extract: (zipPath, destDir) => {
        assert.ok(fs.existsSync(zipPath));
        const out = path.join(destDir, binaryRel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, "#!/bin/sh\necho chrome\n");
      },
    });
    assert.equal(
      downloadedUrl,
      `https://github.com/BetterWright/betterwright/releases/download/${CHROMIUM_FORK_RELEASE_TAG}/test-linux.zip`,
    );
    assert.equal(result.alreadyInstalled, false);
    assert.equal(
      result.binary,
      path.join(home, ".betterwright", "chromium", "linux-x64", "chrome"),
    );
    assert.ok(fs.existsSync(result.binary));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installChromiumFork rejects a SHA-256 mismatch", async () => {
  const home = makeTempDir("bw-fork-bad-");
  const assets = {
    "linux-x64": {
      name: "bad.zip",
      sha256: "0".repeat(64),
    },
  };
  try {
    await assert.rejects(
      () =>
        installChromiumFork({
          platform: "linux",
          arch: "x64",
          home,
          force: true,
          assets,
          log() {},
          download: async (_url, dest) => {
            fs.writeFileSync(dest, "not-the-expected-bytes");
          },
        }),
      /SHA-256 mismatch/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
