import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  bunInheritedExecArgv,
  bunVersion,
  importFlagsFromNodeOptions,
  PINNED_BUN_VERSION,
  packageAddCommand,
  runtimeIsBun,
  runtimeLabel,
  runtimeSupported,
} from "../../dist/src/runtime.js";

function bunPreloadPath(fileUrl) {
  const filePath = fileURLToPath(fileUrl);
  return process.platform === "win32" ? filePath.replaceAll("\\", "/") : filePath;
}

test("Bun 1.4 is the pinned project runtime", () => {
  assert.equal(PINNED_BUN_VERSION, "1.4.0");
  assert.equal(runtimeIsBun(), true);
  assert.equal(bunVersion(), "1.4.0");
  assert.equal(runtimeLabel(), "Bun");
  assert.equal(runtimeSupported(), true);
});

test("NODE_OPTIONS --import flags become argv Bun will honor", () => {
  assert.deepEqual(importFlagsFromNodeOptions(""), []);
  assert.deepEqual(importFlagsFromNodeOptions("--import=file:///tmp/hook.mjs"), [
    "--import",
    "file:///tmp/hook.mjs",
  ]);
  assert.deepEqual(
    importFlagsFromNodeOptions('--import "file:///tmp/quoted.mjs" --other'),
    ["--import", "file:///tmp/quoted.mjs"],
  );
  assert.deepEqual(importFlagsFromNodeOptions("--import file:///tmp/space.mjs --trace-warnings"), [
    "--import",
    "file:///tmp/space.mjs",
  ]);
});

test("bunInheritedExecArgv reads NODE_OPTIONS only on Bun", () => {
  const dummy = pathToFileURL(path.join(os.tmpdir(), "from-env.mjs")).href;
  assert.deepEqual(bunInheritedExecArgv({ NODE_OPTIONS: `--import=${dummy}` }), [
    "--import",
    bunPreloadPath(dummy),
  ]);
});

test("Bun can preload a NODE_OPTIONS file URL whose path contains a tilde", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "RUNNER~1-"));
  const hook = path.join(dir, "boot-hook.mjs");
  fs.writeFileSync(hook, "globalThis.__bwPreloadMarker = 1;\n");
  try {
    const url = pathToFileURL(hook).href;
    assert.match(url, /%7E/i, "pathToFileURL must encode the 8.3-style tilde");
    const argv = bunInheritedExecArgv({ NODE_OPTIONS: `--import=${url}` });
    assert.deepEqual(argv, ["--import", bunPreloadPath(url)]);
    assert.equal(argv[1].includes("~"), true);
    assert.equal(argv[1].includes("%7E"), false);
    const result = spawnSync(
      process.execPath,
      [...argv, "-e", "process.exit(globalThis.__bwPreloadMarker === 1 ? 0 : 2)"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("packageAddCommand matches the host package manager", () => {
  assert.equal(packageAddCommand("x"), "bun add x");
  assert.equal(packageAddCommand("x", true), "bun add -g x");
});
