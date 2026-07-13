#!/usr/bin/env node
// Copy the canonical worker (src/worker.mjs) into the Python package so a pip
// install ships the same runtime the npm package uses. Run after editing the
// worker; CI fails if the two copies drift (see .github/workflows).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "worker.mjs");
const target = path.join(root, "python", "src", "betterwright", "_worker", "worker.mjs");

const check = process.argv.includes("--check");
if (check) {
  const same =
    fs.existsSync(target) &&
    fs.readFileSync(source, "utf8") === fs.readFileSync(target, "utf8");
  if (!same) {
    console.error("worker copies differ — run `node scripts/sync-worker.mjs`");
    process.exit(1);
  }
  console.log("worker copies are in sync");
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(
    `synced ${path.relative(root, source)} -> ${path.relative(root, target)}`,
  );
}
