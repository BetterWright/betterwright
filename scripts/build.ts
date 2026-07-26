#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

fs.rmSync(dist, { recursive: true, force: true });

const result = spawnSync(process.execPath, [tsc, "--project", "tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// TypeScript 7 always adds a strict-mode directive to script files. These two
// outputs are intentionally evaluated as classic standalone scripts (an MV3
// service worker and an isolated-world injection), so preserve their previous
// execution mode exactly.
for (const standalone of [
  path.join(dist, "src", "cdpfree", "extension", "background.js"),
  path.join(dist, "src", "vault-sensor.js"),
]) {
  const source = fs.readFileSync(standalone, "utf8");
  const directive = '"use strict";\n';
  if (!source.startsWith(directive)) {
    throw new Error(`Expected TypeScript strict-mode directive in ${standalone}`);
  }
  fs.writeFileSync(standalone, source.slice(directive.length));
}

const extensionSource = path.join(root, "src", "cdpfree", "extension");
const extensionOutput = path.join(dist, "src", "cdpfree", "extension");
fs.copyFileSync(
  path.join(extensionSource, "manifest.json"),
  path.join(extensionOutput, "manifest.json"),
);

for (const executable of [
  path.join(dist, "bin", "betterwright.js"),
  path.join(dist, "src", "worker.js"),
]) {
  fs.chmodSync(executable, 0o755);
}
