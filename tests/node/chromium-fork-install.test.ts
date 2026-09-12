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
  chromiumForkInstallReceipt,
  chromiumForkReceiptPath,
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

test("installChromiumFork short-circuits only for the verified pinned archive", async () => {
  const home = makeTempDir("bw-fork-current-");
  const root = path.join(home, ".betterwright", "chromium");
  const binary = path.join(root, "linux-x64", "betterchromium");
  const logs = [];
  try {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "current executable");
    fs.writeFileSync(chromiumForkReceiptPath(root, "linux", "x64"), JSON.stringify(
      chromiumForkInstallReceipt({ platform: "linux", arch: "x64" }),
    ));
    const result = await installChromiumFork({
      platform: "linux",
      arch: "x64",
      home,
      log: (line) => logs.push(String(line)),
      download: async () => { throw new Error("should not download"); },
    });
    assert.equal(result.alreadyInstalled, true);
    assert.equal(result.binary, binary);
    assert.match(logs.join("\n"), /already installed/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installChromiumFork repairs a verified current Windows layout in place", async () => {
  const home = makeTempDir("bw-fork-win-repair-");
  const directory = path.join(home, ".betterwright", "chromium", "win-x64");
  const binary = path.join(directory, "betterchromium.exe");
  const manifest = path.join(directory, `${BETTERWRIGHT_CHROMIUM_VERSION}.manifest`);
  const logs = [];
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(binary, "test executable");
    fs.writeFileSync(path.join(directory, "chrome_elf.dll"), "test dll");
    fs.writeFileSync(chromiumForkReceiptPath(path.dirname(directory), "win32", "x64"), JSON.stringify(
      chromiumForkInstallReceipt({ platform: "win32", arch: "x64" }),
    ));
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

test("installChromiumFork reinstalls a managed Windows tree missing chrome_elf.dll", async () => {
  const home = makeTempDir("bw-fork-win-incomplete-");
  const directory = path.join(home, ".betterwright", "chromium", "win-x64");
  const binary = path.join(directory, "betterchromium.exe");
  const payload = Buffer.from("replacement-windows-zip");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const logs = [];
  let downloads = 0;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(binary, "incomplete executable");
    const result = await installChromiumFork({
      platform: "win32",
      arch: "x64",
      home,
      assets: { "win32-x64": { name: "replacement.zip", sha256 } },
      log: (line) => logs.push(String(line)),
      download: async (_url, dest) => {
        downloads += 1;
        fs.writeFileSync(dest, payload);
      },
      extract: (_zipPath, destDir) => {
        const out = path.join(destDir, "win-x64", "betterchromium.exe");
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, "replacement executable");
        fs.writeFileSync(path.join(path.dirname(out), "chrome_elf.dll"), "replacement dll");
      },
    });
    assert.equal(downloads, 1);
    assert.equal(result.alreadyInstalled, false);
    assert.equal(result.binary, binary);
    assert.equal(fs.readFileSync(binary, "utf8"), "replacement executable");
    assert.equal(
      fs.readFileSync(
        path.join(directory, `${BETTERWRIGHT_CHROMIUM_VERSION}.manifest`),
        "utf8",
      ),
      windowsVersionAssemblyManifest(),
    );
    assert.match(logs.join("\n"), /incomplete.*missing.*chrome_elf\.dll/i);
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

for (const stale of ["missing receipt", "corrupt receipt", "old version", "old release", "wrong archive", "wrong checksum"]) {
  test(`setup replaces an existing binary with ${stale} without --force`, async () => {
    const home = makeTempDir("bw-fork-upgrade-");
    const root = path.join(home, ".betterwright", "chromium");
    const binary = path.join(root, "linux-x64", "betterchromium");
    const payload = Buffer.from("security-update-archive");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const assets = { "linux-x64": { name: "current.zip", sha256 } };
    const current = chromiumForkInstallReceipt({ platform: "linux", arch: "x64", assets });
    let downloads = 0;
    try {
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, "vulnerable executable");
      fs.writeFileSync(path.join(path.dirname(binary), "obsolete-file"), "old");
      const receiptPath = chromiumForkReceiptPath(root, "linux", "x64");
      const old = { ...current };
      if (stale === "old version") old.version = "150.0.7871.24";
      if (stale === "old release") old.releaseTag = "prior-release";
      if (stale === "wrong archive") old.assetName = "other-platform.zip";
      if (stale === "wrong checksum") old.sha256 = "0".repeat(64);
      if (stale !== "missing receipt") fs.writeFileSync(receiptPath, stale === "corrupt receipt" ? "{" : JSON.stringify(old));
      const options = {
        home, platform: "linux" as const, arch: "x64" as const, assets, log() {},
        download: async (_url, dest) => { downloads++; fs.writeFileSync(dest, payload); },
        extract: (_zip, dest) => {
          // The old tree stays intact until the new archive is fully staged.
          assert.equal(fs.readFileSync(binary, "utf8"), "vulnerable executable");
          const out = path.join(dest, "linux-x64", "betterchromium");
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, "patched executable");
        },
      };
      const result = await installChromiumFork(options);
      assert.equal(result.alreadyInstalled, false);
      assert.equal(downloads, 1);
      assert.equal(fs.readFileSync(binary, "utf8"), "patched executable");
      assert.equal(fs.existsSync(path.join(path.dirname(binary), "obsolete-file")), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(receiptPath, "utf8")), current);
      assert.equal((await installChromiumFork(options)).alreadyInstalled, true);
      assert.equal(downloads, 1);
      assert.deepEqual(fs.readdirSync(root), ["linux-x64"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const failure of ["checksum", "extraction", "missing binary", "missing Windows DLL"]) {
  test(`failed upgrade (${failure}) preserves the prior browser and receipt`, async () => {
    const home = makeTempDir("bw-fork-upgrade-failure-");
    const root = path.join(home, ".betterwright", "chromium");
    const directory = path.join(root, "win-x64");
    const binary = path.join(directory, "betterchromium.exe");
    const receiptPath = chromiumForkReceiptPath(root, "win32", "x64");
    const payload = Buffer.from("security-update-archive");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(binary, "prior executable");
      fs.writeFileSync(receiptPath, "prior receipt");
      await assert.rejects(() => installChromiumFork({
        home, platform: "win32", arch: "x64", log() {},
        assets: { "win32-x64": { name: "current.zip", sha256 } },
        download: async (_url, dest) => { fs.writeFileSync(dest, failure === "checksum" ? "bad" : payload); },
        extract: (_zip, dest) => {
          if (failure === "extraction") throw new Error("extraction failed");
          if (failure === "missing binary") return;
          const out = path.join(dest, "win-x64", "betterchromium.exe");
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, "incomplete executable");
        },
      }), failure === "checksum" ? /SHA-256 mismatch/ : failure === "extraction" ? /extraction failed/ : failure === "missing binary" ? /binary missing/ : /chrome_elf.dll is missing/);
      assert.equal(fs.readFileSync(binary, "utf8"), "prior executable");
      assert.equal(fs.readFileSync(receiptPath, "utf8"), "prior receipt");
      assert.deepEqual(fs.readdirSync(root), ["win-x64"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
