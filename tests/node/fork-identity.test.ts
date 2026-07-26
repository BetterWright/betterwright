import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  forkFontsDir,
  forkMacIdentity,
  prepareForkFontsConfig,
} from "../../dist/src/fork-identity.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("fork mac identity carries no linux or headless markers", () => {
  const id = forkMacIdentity("150.0.7871.129");
  assert.match(id.userAgent, /Macintosh; Intel Mac OS X 10_15_7/);
  assert.match(id.userAgent, /Chrome\/150\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(id.userAgent, /Linux|X11|Headless/);
  assert.equal(id.navigatorPlatform, "MacIntel");
  assert.equal(id.userAgentMetadata.platform, "macOS");
  assert.equal(id.userAgentMetadata.architecture, "arm");
  assert.equal(id.userAgentMetadata.mobile, false);
});

test("fork mac identity tracks the pinned chromium version", () => {
  const id = forkMacIdentity("151.1.2.3");
  const brands = id.userAgentMetadata.fullVersionList;
  assert.deepEqual(
    brands.find((b) => b.brand === "Chromium"),
    { brand: "Chromium", version: "151.1.2.3" },
  );
  assert.deepEqual(
    brands.find((b) => b.brand === "Google Chrome"),
    { brand: "Google Chrome", version: "151.1.2.3" },
  );
  assert.ok(
    id.userAgentMetadata.brands.some(
      (b) => b.brand === "Google Chrome" && b.version === "151",
    ),
  );
  assert.match(id.userAgent, /Chrome\/151\.0\.0\.0/);
});

test("fork mac identity matches real consumer hardware", () => {
  const id = forkMacIdentity("150.0.7871.129");
  assert.equal(id.hardwareConcurrency, 12);
  assert.equal(id.deviceMemory, 16);
  assert.equal(id.screen.devicePixelRatio, 2);
  assert.ok(id.screen.availHeight < id.screen.height); // menu bar + dock
  assert.match(id.webgl.unmaskedRenderer, /ANGLE Metal Renderer: Apple M4 Pro/);
  assert.equal(id.webgl.unmaskedVendor, "Google Inc. (Apple)");
});

test("fonts config is generated next to the binary's font bundle", () => {
  const root = makeTempDir("bw-fonts-");
  const binDir = path.join(root, "linux-x64");
  const fontsDir = path.join(binDir, "fonts", "ttf");
  fs.mkdirSync(fontsDir, { recursive: true });
  const runtimeDir = path.join(root, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const result = prepareForkFontsConfig({
    forkBinary: path.join(binDir, "chrome"),
    runtimeDir,
  });
  assert.ok(result);
  const conf = fs.readFileSync(result.confPath, "utf8");
  assert.ok(conf.includes(`<dir>${fontsDir}</dir>`));
  assert.ok(conf.includes("Helvetica Neue"));
  assert.ok(fs.statSync(result.cacheDir).isDirectory());
});

test("fonts config is null without a bundle (host fontconfig fallback)", () => {
  const root = makeTempDir("bw-fonts-none-");
  const result = prepareForkFontsConfig({
    forkBinary: path.join(root, "chrome"),
    runtimeDir: root,
  });
  assert.equal(result, null);
  assert.equal(forkFontsDir(path.join(root, "chrome")), null);
});

test("forkFontsDir finds fonts/ttf next to the binary", () => {
  const root = makeTempDir("bw-fonts-dir-");
  const fontsDir = path.join(root, "fonts", "ttf");
  fs.mkdirSync(fontsDir, { recursive: true });
  assert.equal(forkFontsDir(path.join(root, "chrome")), fontsDir);
});
