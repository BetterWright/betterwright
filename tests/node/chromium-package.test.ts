import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { windowsVersionAssemblyManifest } from "../../dist/src/chromium-fork.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.platform === "win32" ? "python" : "python3";
const PACKAGER = path.join(ROOT, "scripts/chromium/package-runtime.py");

test("native mac packaging replaces removed files and preserves the prior archive on failure", { skip: process.platform !== "darwin" }, () => {
  const temporary = makeTempDir("bw-package-mac-");
  try {
    const out = path.join(temporary, "out");
    const contents = path.join(out, "BetterChromium.app", "Contents");
    const executable = path.join(contents, "MacOS", "BetterChromium");
    const archive = path.join(temporary, "browser.zip");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync("/usr/bin/true", executable);
    fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>BetterChromium</string>
<key>CFBundleIdentifier</key><string>com.betterwright.packaging-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>\n`);
    const obsolete = path.join(contents, "obsolete.txt");
    fs.writeFileSync(obsolete, "old release only");
    const packageMac = () => spawnSync("bash", [path.join(ROOT, "scripts/chromium/package.sh"), "mac", out, archive], { encoding: "utf8", timeout: 30_000 });
    const first = packageMac();
    assert.equal(first.status, 0, first.stderr);
    fs.unlinkSync(obsolete);
    const second = packageMac();
    assert.equal(second.status, 0, second.stderr);
    const inspect = spawnSync(PYTHON, ["-c", "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))", archive], { encoding: "utf8" });
    assert.equal(inspect.status, 0, inspect.stderr);
    const names: string[] = JSON.parse(inspect.stdout);
    assert.ok(names.includes("mac-arm64/BetterChromium.app/Contents/MacOS/BetterChromium"));
    assert.ok(!names.some((name) => name.endsWith("/obsolete.txt")));
    const previous = fs.readFileSync(archive);
    fs.unlinkSync(executable);
    const failed = packageMac();
    assert.notEqual(failed.status, 0);
    assert.deepEqual(fs.readFileSync(archive), previous);
    assert.ok(!fs.readdirSync(temporary).some((name) => name.startsWith(".bw-archive.")));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

for (const platform of ["win", "linux"]) {
  test(`native ${platform} archive includes runtime files and excludes build intermediates`, () => {
    const temporary = makeTempDir("bw-package-");
    try {
      const out = path.join(temporary, "out");
      const archive = path.join(temporary, "browser.zip");
      const manifest = path.join(temporary, "153.0.8010.36.manifest");
      fs.writeFileSync(manifest, windowsVersionAssemblyManifest("153.0.8010.36"));
      const files = ["resources.pak", "icudtl.dat", "locales/en-US.pak", "chrome_100_percent.pak", ...(
        platform === "win"
          ? ["chrome.exe", "chrome.dll", "chrome_elf.dll", "libEGL.dll", "libGLESv2.dll"]
          : ["chrome", "chrome-wrapper", "chrome_sandbox", "product_logo_48.png", "libEGL.so", "libGLESv2.so", "libvk_swiftshader.so", "vk_swiftshader_icd.json"]
      )];
      for (const file of [...files, "obj/large.o", "gen/unrelated.pak", "151.0.7922.108.manifest"]) {
        const target = path.join(out, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file === "chrome-wrapper" ? 'exec "$HERE/chrome" "$@"\n' : "runtime fixture");
      }
      fs.writeFileSync(path.join(out, "betterchromium.runtime_deps"), files.join("\n"));
      const result = spawnSync(PYTHON, [PACKAGER, platform, out, archive, "--manifest", manifest], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const inspect = spawnSync(PYTHON, ["-c", "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))", archive], { encoding: "utf8" });
      assert.equal(inspect.status, 0, inspect.stderr);
      const contents = JSON.parse(inspect.stdout);
      const prefix = platform === "win" ? "win-x64" : "linux-x64";
      assert.ok(contents[`${prefix}/${platform === "win" ? "betterchromium.exe" : "betterchromium"}`]);
      assert.ok(contents[`${prefix}/locales/en-US.pak`]);
      assert.ok(Object.keys(contents).every((name) => !name.includes("/obj/") && !name.includes("/gen/") && !name.includes("151.0.")));
      if (platform === "win") {
        assert.equal(contents[`${prefix}/153.0.8010.36.manifest`], windowsVersionAssemblyManifest("153.0.8010.36"));
      } else {
        assert.equal(contents[`${prefix}/chrome-wrapper`], 'exec "$HERE/betterchromium" "$@"\n');
        assert.ok(contents[`${prefix}/chrome-sandbox`]);
      }
      // A missing required runtime file must fail before replacing a prior archive.
      fs.unlinkSync(path.join(out, platform === "win" ? "chrome_elf.dll" : "icudtl.dat"));
      fs.writeFileSync(archive, "previous archive");
      const failed = spawnSync(PYTHON, [PACKAGER, platform, out, archive, "--manifest", manifest], { encoding: "utf8" });
      assert.notEqual(failed.status, 0);
      assert.equal(fs.readFileSync(archive, "utf8"), "previous archive");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test("native packaging rejects paths outside the build output", () => {
  const temporary = makeTempDir("bw-package-path-");
  try {
    const out = path.join(temporary, "out");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(temporary, "outside"), "must not be packaged");
    fs.writeFileSync(path.join(out, "betterchromium.runtime_deps"), "../outside\n");
    const result = spawnSync(PYTHON, [PACKAGER, "linux", out, path.join(temporary, "browser.zip")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid browser runtime dependency/);
    assert.equal(fs.existsSync(path.join(temporary, "browser.zip")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
