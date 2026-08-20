import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BETTERWRIGHT_CHROMIUM_VERSION,
  CHROMIUM_FORK_ASSETS,
  CHROMIUM_FORK_RELEASE_TAG,
  windowsVersionAssemblyManifest,
} from "../../dist/src/chromium-fork.js";
import {
  _extractZipForTest,
  chromiumForkAssetForHost,
  installChromiumFork,
} from "../../dist/src/chromium-fork-install.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);

test("Chromium 151 release is pinned to verified public assets", () => {
  assert.equal(
    CHROMIUM_FORK_RELEASE_TAG,
    `betterchromium-${BETTERWRIGHT_CHROMIUM_VERSION}-r3`,
  );
  assert.deepEqual(
    chromiumForkAssetForHost({ platform: "darwin", arch: "arm64" }),
    CHROMIUM_FORK_ASSETS["darwin-arm64"],
  );
  assert.deepEqual(
    chromiumForkAssetForHost({ platform: "linux", arch: "x64" }),
    CHROMIUM_FORK_ASSETS["linux-x64"],
  );
  assert.deepEqual(
    chromiumForkAssetForHost({ platform: "win32", arch: "x64" }),
    CHROMIUM_FORK_ASSETS["win32-x64"],
  );
  assert.deepEqual(CHROMIUM_FORK_ASSETS, {
    "darwin-arm64": {
      name: "betterchromium-mac-arm64.zip",
      sha256:
        "22484b810c601697afd7d0a82f39ced7f24ac7d8a2b01e52c5a61e9a6096ec67",
    },
    "linux-x64": {
      name: "betterchromium-linux-x64.zip",
      sha256:
        "3eabe54aae9d8bde34170a6930df21932325be4570baf9d45431baad6cd03d98",
    },
    "win32-x64": {
      name: "betterchromium-win-x64.zip",
      sha256:
        "03d8abb5d6064bbd808cf52c2a327692502c4ca6c565b2e1cdb639200c52dccb",
    },
  });
});

test("Windows packaging carries Chromium's matching private assembly manifest", () => {
  const manifestPath = path.join(
    ROOT,
    "scripts",
    "chromium",
    `${BETTERWRIGHT_CHROMIUM_VERSION}.manifest`,
  );
  assert.equal(
    fs.readFileSync(manifestPath, "utf8"),
    windowsVersionAssemblyManifest(),
  );
  const packageScript = fs.readFileSync(
    path.join(ROOT, "scripts", "chromium", "package.sh"),
    "utf8",
  );
  assert.match(packageScript, /chrome_elf\.dll missing/);
  assert.match(
    packageScript,
    /cp "\$root\/scripts\/chromium\/\$chromium_version\.manifest" "\$stage\/win-x64\/\$chromium_version\.manifest"/,
  );
});

test("installChromiumFork skips unsupported platforms without a public artifact", async () => {
  const result = await installChromiumFork({
    platform: "linux",
    arch: "arm64",
    home: "/tmp/bw-home",
    log() {},
  });
  assert.match(result.skipped, /No public BetterChromium artifact/);
  assert.equal(result.binary, null);
});

test("Windows fork extraction uses the built-in tar executable", () => {
  const calls = [];
  const destDir = makeTempDir("bw-fork-extract-");
  try {
    _extractZipForTest("C:\\tmp\\fork.zip", destDir, {
      platform: "win32",
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(calls, [{
      command: "tar.exe",
      args: ["-xf", "C:\\tmp\\fork.zip", "-C", destDir],
      options: { encoding: "utf8" },
    }]);
  } finally {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test("Windows fork extraction reports tar failures", () => {
  const destDir = makeTempDir("bw-fork-extract-fail-");
  try {
    assert.throws(
      () =>
        _extractZipForTest("C:\\tmp\\fork.zip", destDir, {
          platform: "win32",
          spawn: () => ({ status: 2, stdout: "", stderr: "bad archive" }),
        }),
      /tar\.exe extract failed: bad archive/,
    );
  } finally {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test("installChromiumFork short-circuits when already installed", async () => {
  const home = "/home/deploy";
  const binary = path.join(home, ".betterwright", "chromium", "linux-x64", "betterchromium");
  const logs = [];
  const result = await installChromiumFork({
    platform: "linux",
    arch: "x64",
    home,
    force: false,
    existsSync: (p) => p === binary,
    log: (line) => logs.push(String(line)),
    assets: { "linux-x64": { name: "candidate.zip", sha256: "0".repeat(64) } },
    download: async () => {
      throw new Error("should not download");
    },
  });
  assert.equal(result.alreadyInstalled, true);
  assert.equal(result.binary, binary);
  assert.match(logs.join("\n"), /already installed/);
});

test("installChromiumFork repairs an existing r3 Windows layout in place", async () => {
  const home = makeTempDir("bw-fork-win-repair-");
  const directory = path.join(home, ".betterwright", "chromium", "win-x64");
  const binary = path.join(directory, "betterchromium.exe");
  const manifest = path.join(directory, `${BETTERWRIGHT_CHROMIUM_VERSION}.manifest`);
  const logs = [];
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(binary, "test executable");
    fs.writeFileSync(path.join(directory, "chrome_elf.dll"), "test dll");
    const result = await installChromiumFork({
      platform: "win32",
      arch: "x64",
      home,
      log: (line) => logs.push(String(line)),
      download: async () => {
        throw new Error("should not download");
      },
    });
    assert.equal(result.binary, binary);
    assert.equal(result.alreadyInstalled, true);
    assert.equal(fs.readFileSync(manifest, "utf8"), windowsVersionAssemblyManifest());
    assert.match(logs.join("\n"), /Repaired BetterChromium Windows side-by-side manifest/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installChromiumFork downloads, verifies, and installs the Windows layout", async () => {
  const home = makeTempDir("bw-fork-home-");
  const payload = Buffer.from("betterchromium-test-zip");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const assets = {
    "win32-x64": { name: "test-windows.zip", sha256 },
  };
  const binaryRel = path.join("win-x64", "betterchromium.exe");
  let downloadedUrl = null;

  try {
    const result = await installChromiumFork({
      platform: "win32",
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
        fs.writeFileSync(out, "#!/bin/sh\necho BetterChromium\n");
        fs.writeFileSync(path.join(path.dirname(out), "chrome_elf.dll"), "test dll");
      },
    });
    assert.equal(
      downloadedUrl,
      `https://github.com/BetterWright/betterwright/releases/download/${CHROMIUM_FORK_RELEASE_TAG}/test-windows.zip`,
    );
    assert.equal(result.alreadyInstalled, false);
    assert.equal(
      result.binary,
      path.join(home, ".betterwright", "chromium", "win-x64", "betterchromium.exe"),
    );
    assert.ok(fs.existsSync(result.binary));
    assert.equal(
      fs.readFileSync(
        path.join(
          home,
          ".betterwright",
          "chromium",
          "win-x64",
          `${BETTERWRIGHT_CHROMIUM_VERSION}.manifest`,
        ),
        "utf8",
      ),
      windowsVersionAssemblyManifest(),
    );
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
