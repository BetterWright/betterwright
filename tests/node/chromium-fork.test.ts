import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BETTERWRIGHT_CHROMIUM_VERSION,
  chromiumForkContextOptions,
  chromiumForkPlatformSupported,
  resolveChromiumForkBinary,
  selectManagedBrowserBackend,
} from "../../dist/src/chromium-fork.js";

const present = () => true;
const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);

const NO_FORK_HOME = path.join(ROOT, "tests", "fixtures", "no-such-home");

test("Chromium fork stays disabled when no runtime path is configured", () => {
  assert.equal(
    resolveChromiumForkBinary({ env: {}, home: NO_FORK_HOME }),
    null,
  );
  assert.equal(BETTERWRIGHT_CHROMIUM_VERSION, "151.0.7922.108");
});

test("default root discovers a deployed artifact (zero-config fork)", () => {
  const home = "/home/deploy";
  const binary = path.join(home, ".betterwright", "chromium", "linux-x64", "betterchromium");
  assert.equal(
    resolveChromiumForkBinary({
      env: {},
      platform: "linux",
      arch: "x64",
      home,
      existsSync: (p) => p === binary,
    }),
    binary,
  );
});

test("supported platforms with a missing deployment remain unavailable", () => {
  assert.equal(
    resolveChromiumForkBinary({
      env: {},
      platform: "win32",
      arch: "x64",
      home: "C:\\Users\\deploy",
      existsSync: () => false,
    }),
    null,
  );
  assert.deepEqual(
    selectManagedBrowserBackend({
      chromiumFork: null,
      env: {},
      platform: "win32",
      arch: "x64",
    }),
    { browser: "unavailable", cloakFallback: null },
  );
});

test("unsupported platforms automatically select managed CloakBrowser", () => {
  assert.equal(
    resolveChromiumForkBinary({
      env: {},
      platform: "linux",
      arch: "arm64",
      home: "/home/pi",
      existsSync: () => false,
    }),
    null,
  );
  assert.equal(
    chromiumForkPlatformSupported({ platform: "linux", arch: "arm64" }),
    false,
  );
  assert.deepEqual(
    selectManagedBrowserBackend({
      chromiumFork: null,
      env: {},
      platform: "linux",
      arch: "arm64",
    }),
    { browser: "cloak", cloakFallback: "unsupported-platform" },
  );
});

test("all published platform layouts select native BetterChromium", () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["linux", "x64"],
    ["win32", "x64"],
  ]) {
    assert.equal(chromiumForkPlatformSupported({ platform, arch }), true);
    assert.deepEqual(
      selectManagedBrowserBackend({
        chromiumFork: "/managed/betterchromium",
        env: {},
        platform,
        arch,
      }),
      { browser: "chromium-fork", cloakFallback: null },
    );
  }
});

test("explicit off forces managed CloakBrowser even with an artifact", () => {
  assert.equal(
    resolveChromiumForkBinary({
      env: { BETTERWRIGHT_CHROMIUM_ROOT: "off" },
      existsSync: present,
    }),
    null,
  );
  assert.deepEqual(
    selectManagedBrowserBackend({
      env: { BETTERWRIGHT_CHROMIUM_ROOT: "off" },
      platform: "linux",
      arch: "x64",
    }),
    { browser: "cloak", cloakFallback: "explicit" },
  );
  assert.equal(
    resolveChromiumForkBinary({
      env: { BETTERWRIGHT_CHROMIUM_PATH: "OFF" },
      existsSync: present,
    }),
    null,
  );
});

test("Chromium fork preserves native metrics and normal browser behavior", () => {
  const options = chromiumForkContextOptions({
    platform: "darwin",
    getuid: () => 501,
  });
  assert.equal(options.viewport, null);
  assert.equal(options.chromiumSandbox, true);
  assert.ok(options.ignoreDefaultArgs.includes("--disable-extensions"));
  assert.ok(options.ignoreDefaultArgs.includes("--disable-back-forward-cache"));
  assert.ok(
    options.ignoreDefaultArgs.some((arg) =>
      arg.includes("ThirdPartyStoragePartitioning"),
    ),
  );
  assert.equal(
    options.ignoreDefaultArgs.includes("--remote-debugging-pipe"),
    false,
  );
});

test("managed worker avoids detectable WebSocket interception", () => {
  const workerSource = fs.readFileSync(
    path.join(ROOT, "dist", "src", "worker.js"),
    "utf8",
  );
  assert.doesNotMatch(workerSource, /\.routeWebSocket\s*\(/);
  assert.match(workerSource, /createGuardProxy\s*\(/);
});

test("Chromium fork disables the Linux sandbox only for uid zero", () => {
  assert.equal(
    chromiumForkContextOptions({ platform: "linux", getuid: () => 0 })
      .chromiumSandbox,
    false,
  );
  assert.equal(
    chromiumForkContextOptions({ platform: "linux", getuid: () => 1000 })
      .chromiumSandbox,
    true,
  );
});

test("explicit Chromium fork path wins and must be absolute", () => {
  assert.equal(
    resolveChromiumForkBinary({
      env: {
        BETTERWRIGHT_CHROMIUM_PATH: "/opt/betterwright/chrome",
        BETTERWRIGHT_CHROMIUM_ROOT: "/ignored",
      },
      existsSync: present,
    }),
    "/opt/betterwright/chrome",
  );
  assert.throws(
    () =>
      resolveChromiumForkBinary({
        env: { BETTERWRIGHT_CHROMIUM_PATH: "relative/chrome" },
        existsSync: present,
      }),
    /absolute path/,
  );
});

test("artifact root resolves native macOS, Linux, and Windows layouts", () => {
  assert.equal(
    resolveChromiumForkBinary({
      env: { BETTERWRIGHT_CHROMIUM_ROOT: "/opt/betterwright" },
      platform: "darwin",
      arch: "arm64",
      existsSync: present,
    }),
    path.join(
      "/opt/betterwright",
      "mac-arm64",
      "BetterChromium.app",
      "Contents",
      "MacOS",
      "BetterChromium",
    ),
  );
  assert.equal(
    resolveChromiumForkBinary({
      env: { BETTERWRIGHT_CHROMIUM_ROOT: "/opt/betterwright" },
      platform: "linux",
      arch: "x64",
      existsSync: present,
    }),
    path.join("/opt/betterwright", "linux-x64", "betterchromium"),
  );
  assert.equal(
    resolveChromiumForkBinary({
      env: { BETTERWRIGHT_CHROMIUM_ROOT: "/opt/betterwright" },
      platform: "win32",
      arch: "x64",
      existsSync: present,
    }),
    path.join("/opt/betterwright", "win-x64", "betterchromium.exe"),
  );
});

test("configured fork paths fail closed when missing or unsupported", () => {
  assert.throws(
    () =>
      resolveChromiumForkBinary({
        env: { BETTERWRIGHT_CHROMIUM_PATH: "/missing/chrome" },
        existsSync: () => false,
      }),
    /not found/,
  );
  assert.throws(
    () =>
      resolveChromiumForkBinary({
        env: { BETTERWRIGHT_CHROMIUM_ROOT: "/opt/betterwright" },
        platform: "linux",
        arch: "riscv64",
        existsSync: present,
      }),
    /No BetterChromium artifact layout/,
  );
  assert.deepEqual(
    selectManagedBrowserBackend({
      env: { BETTERWRIGHT_CHROMIUM_ROOT: "/opt/betterwright" },
      platform: "linux",
      arch: "arm64",
    }),
    { browser: "unavailable", cloakFallback: null },
  );
});
