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

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
