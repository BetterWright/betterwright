import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  acceptLanguageForLocale,
  forkFontsDir,
  forkIdentityContextOptions,
  forkIdentityGeometryArgs,
  forkMacIdentity,
  prepareForkFontsConfig,
} from "../../dist/src/fork-identity.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("Chromium 151 identity exposes a stable versioned contract", () => {
  const id = forkMacIdentity("151.0.7890.1", { locale: "de-de" });
  assert.equal(id.profileId, "macos-m4-pro-chromium-151-v1");
  assert.equal(id.profileSchemaVersion, 1);
  assert.equal(id.chromiumVersion, "151.0.7890.1");
  assert.equal(id.locale, "de-DE");
  assert.equal(id.acceptLanguage, "de-DE,de;q=0.9");
  assert.ok(Object.isFrozen(id));
  assert.ok(Object.isFrozen(id.screen));
  assert.match(id.userAgent, /Chrome\/151\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(id.userAgent, /Linux|X11|Headless/);
  assert.equal(id.navigatorPlatform, "MacIntel");
  assert.equal(id.userAgentMetadata.platform, "macOS");
  assert.equal(id.userAgentMetadata.architecture, "arm");
});

test("Accept-Language is derived from configured locale", () => {
  assert.equal(acceptLanguageForLocale("en-US"), "en-US,en;q=0.9");
  assert.equal(acceptLanguageForLocale("ja"), "ja");
  assert.equal(acceptLanguageForLocale("zh-hant-tw"), "zh-Hant-TW,zh;q=0.9");
});

test("fork identity rejects malformed or unsupported configuration", () => {
  assert.throws(() => forkMacIdentity("151"), /four numeric components/);
  assert.throws(() => forkMacIdentity("150.0.7871.129"), /supports Chromium 151/);
  assert.throws(
    () => forkMacIdentity("151.0.7890.1", { locale: "not_a_locale" }),
    /Invalid fork identity locale/,
  );
  assert.throws(() => acceptLanguageForLocale("en-US-u-ca-gregory"), /extensions/);
});

test("identity context and geometry stay coherent with the capture", () => {
  const id = forkMacIdentity("151.0.7890.1", { locale: "fr-CA" });
  assert.deepEqual(forkIdentityContextOptions(id), {
    userAgent: id.userAgent,
    locale: "fr-CA",
  });
  assert.deepEqual(forkIdentityGeometryArgs(id), [
    "--window-size=1800,1169",
    "--force-device-scale-factor=2",
  ]);
  assert.deepEqual(forkIdentityGeometryArgs(id, { headedInvisible: true }), [
    "--window-size=1800,1169",
    "--force-device-scale-factor=2",
    "--window-position=32000,32000",
  ]);
  assert.equal(id.hardwareConcurrency, 12);
  assert.equal(id.deviceMemory, 16);
  assert.equal(id.screen.availHeight, 1049);
  assert.match(id.webgl.unmaskedRenderer, /ANGLE Metal Renderer: Apple M4 Pro/);
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
