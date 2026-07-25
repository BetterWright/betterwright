#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests", "node");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs") && name !== "browser.test.mjs")
  .sort()
  .map((name) => path.join("tests", "node", name));

if (!files.length) {
  console.error("No Node unit test files found.");
  process.exit(1);
}

// Coverage is opt-in and report-only: it prints Node's coverage table without
// enforcing thresholds, so this experimental feature can never turn a passing
// suite red. CI sets BETTERWRIGHT_COVERAGE=1 to keep the number visible.
// (--test-coverage-exclude needs Node >= 22.5; the flag is only added when
// coverage is requested, so the default run works on any supported Node.)
const coverageArgs =
  process.env.BETTERWRIGHT_COVERAGE === "1"
    ? ["--experimental-test-coverage", "--test-coverage-exclude=tests/**"]
    : [];
const result = spawnSync(process.execPath, [...coverageArgs, "--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
