import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { OBSCURA_RELEASE_TAG } from "../../dist/src/obscura.js";
import {
  _extractObscuraArchiveForTest,
  installObscura,
  obscuraAssetForHost,
} from "../../dist/src/obscura-install.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("Obscura installer selects the host's pinned release asset", () => {
  assert.equal(
    obscuraAssetForHost({ platform: "darwin", arch: "arm64" })?.name,
    "obscura-aarch64-macos-stealth.tar.gz",
  );
  assert.equal(
    obscuraAssetForHost({ platform: "linux", arch: "x64" })?.name,
    "obscura-x86_64-linux-stealth.tar.gz",
  );
});

test("Obscura extraction uses the platform archive tool", () => {
  const calls = [];
  const destDir = makeTempDir("bw-obscura-extract-");
  try {
    _extractObscuraArchiveForTest("C:\\tmp\\obscura.zip", destDir, {
      platform: "win32",
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(calls, [
      {
        command: "tar.exe",
        args: ["-xf", "C:\\tmp\\obscura.zip", "-C", destDir],
        options: { encoding: "utf8" },
      },
    ]);
  } finally {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test("installObscura verifies and installs the release layout", async () => {
  const home = makeTempDir("bw-obscura-home-");
  const payload = Buffer.from("pinned-obscura-archive");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  let downloadedUrl = "";
  try {
    const result = await installObscura({
      home,
      platform: "linux",
      arch: "x64",
      force: true,
      assets: {
        "linux-x64": { name: "obscura-test.tar.gz", sha256 },
      },
      log() {},
      download: async (url, dest) => {
        downloadedUrl = url;
        fs.writeFileSync(dest, payload);
      },
      extract: (_archive, dest) => {
        fs.writeFileSync(path.join(dest, "obscura"), "test binary");
      },
    });
    assert.equal(
      downloadedUrl,
      `https://github.com/h4ckf0r0day/obscura/releases/download/${OBSCURA_RELEASE_TAG}/obscura-test.tar.gz`,
    );
    assert.equal(
      result.binary,
      path.join(home, ".betterwright", "obscura", "linux-x64", "obscura"),
    );
    assert.equal(result.alreadyInstalled, false);
    assert.equal(
      fs.readFileSync(
        path.join(
          home,
          ".betterwright",
          "obscura",
          "linux-x64",
          ".betterwright-version",
        ),
        "utf8",
      ),
      "0.1.11\n",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installObscura rejects an archive checksum mismatch", async () => {
  const home = makeTempDir("bw-obscura-bad-");
  try {
    await assert.rejects(
      () =>
        installObscura({
          home,
          platform: "linux",
          arch: "x64",
          force: true,
          assets: {
            "linux-x64": {
              name: "bad.tar.gz",
              sha256: "0".repeat(64),
            },
          },
          log() {},
          download: async (_url, dest) => fs.writeFileSync(dest, "bad"),
        }),
      /SHA-256 mismatch/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
