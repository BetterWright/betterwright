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
