#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
const workers = String(os.availableParallelism?.() || os.cpus().length);
const browserFile = path.join("tests", "node", "browser.test.ts");
const batches = [files.filter((file) => file !== browserFile)];
if (files.includes(browserFile)) batches.push([browserFile]);
let exitCode = 0;
for (const batch of batches) {
  if (!batch.length) continue;
  const result = spawnSync(
    process.execPath,
    ["test", "--timeout", "120000", `--parallel=${batch.includes(browserFile) ? 1 : workers}`, ...coverageArgs, ...batch],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (!exitCode) exitCode = result.status ?? 1;
}
process.exit(exitCode);
