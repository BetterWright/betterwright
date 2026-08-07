import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  OBSCURA_ASSETS,
  OBSCURA_VERSION,
  resolveObscuraBinary,
} from "../../dist/src/obscura.js";

const present = () => true;

test("Obscura release artifacts are exact-version and checksum pinned", () => {
  assert.equal(OBSCURA_VERSION, "0.1.11");
  assert.deepEqual(
    Object.keys(OBSCURA_ASSETS).sort(),
    [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ],
  );
  for (const asset of Object.values<any>(OBSCURA_ASSETS)) {
    assert.match(asset.name, /-stealth\.(?:tar\.gz|zip)$/);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
});

test("managed Obscura resolves native layouts without client configuration", () => {
  const home = "/home/deploy";
  assert.equal(
    resolveObscuraBinary({
      env: {},
      platform: "linux",
      arch: "arm64",
      home,
      existsSync: present,
      readFileSync: () => `${OBSCURA_VERSION}\n`,
    }),
    path.join(home, ".betterwright", "obscura", "linux-arm64", "obscura"),
  );
  assert.equal(
    resolveObscuraBinary({
      env: {},
      platform: "win32",
      arch: "x64",
      home,
      existsSync: present,
      readFileSync: () => OBSCURA_VERSION,
    }),
    path.join(home, ".betterwright", "obscura", "win32-x64", "obscura.exe"),
  );
});

test("implicit discovery ignores unversioned or stale managed installs", () => {
  assert.equal(
    resolveObscuraBinary({
      env: {},
      existsSync: present,
      readFileSync: () => "0.1.10",
    }),
    null,
  );
  assert.equal(
    resolveObscuraBinary({
      env: {},
      existsSync: present,
      readFileSync: () => {
        throw new Error("missing");
      },
    }),
    null,
  );
});

test("implicit absence falls back while explicit Obscura paths fail closed", () => {
  assert.equal(
    resolveObscuraBinary({ env: {}, existsSync: () => false }),
    null,
  );
  assert.equal(
    resolveObscuraBinary({
      env: { BETTERWRIGHT_OBSCURA_PATH: "off" },
      existsSync: present,
    }),
    null,
  );
  assert.throws(
    () =>
      resolveObscuraBinary({
        env: { BETTERWRIGHT_OBSCURA_PATH: "relative/obscura" },
        existsSync: present,
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      resolveObscuraBinary({
        env: { BETTERWRIGHT_OBSCURA_PATH: "/missing/obscura" },
        existsSync: () => false,
      }),
    /not found/,
  );
});
