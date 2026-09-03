#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests", "node");
const includeBrowser = process.argv.includes("--all");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts") && (includeBrowser || name !== "browser.test.ts"))
  .sort()
  .map((name) => path.join("tests", "node", name));

if (!files.length) {
  console.error("No unit test files found.");
  process.exit(1);
}

const coverageArgs = process.env.BETTERWRIGHT_COVERAGE === "1" ? ["--coverage"] : [];
const result = spawnSync(
  process.execPath,
  ["test", "--timeout", "120000", ...coverageArgs, ...files],
  {
    cwd: root,
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
