import assert from "node:assert/strict";
import { test } from "node:test";

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
  assert.deepEqual(bunInheritedExecArgv({ NODE_OPTIONS: "--import=file:///tmp/from-env.mjs" }), [
    "--import",
    "file:///tmp/from-env.mjs",
  ]);
});

test("packageAddCommand matches the host package manager", () => {
  assert.equal(packageAddCommand("x"), "bun add x");
  assert.equal(packageAddCommand("x", true), "bun add -g x");
});
