#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const failures = [];

function walk(directory): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

function relative(absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function runtimeTargets() {
  const targets = [pkg.main, ...Object.values(pkg.bin || {})];
  for (const value of Object.values(pkg.exports || {})) {
    if (typeof value === "string") {
      if (value.endsWith(".js")) targets.push(value);
      continue;
    }
    if (value && typeof value === "object") {
      for (const target of Object.values(value)) {
        if (typeof target === "string" && target.endsWith(".js")) targets.push(target);
      }
    }
  }
  for (const target of pkg.pi?.extensions || []) targets.push(target);
  return [...new Set(targets.map((target) => String(target).replace(/^\.\//, "")))];
}

if (!fs.existsSync(dist)) failures.push("dist/ is missing; run npm run build");
else {
  const sourceFiles = [
    ...walk(path.join(root, "src")),
    ...walk(path.join(root, "bin")),
  ].filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
  const expected = new Set(
    sourceFiles.map((file) =>
      relative(file)
        .replace(/^src\//, "dist/src/")
        .replace(/^bin\//, "dist/bin/")
        .replace(/\.ts$/, ".js"),
    ),
  );
  const emitted = new Set(walk(dist).filter((file) => file.endsWith(".js")).map(relative));
  const missing = [...expected].filter((file) => !emitted.has(file));
  const unexpected = [...emitted].filter((file) => !expected.has(file));
  if (missing.length) failures.push(`build omitted JavaScript: ${missing.join(", ")}`);
  if (unexpected.length) failures.push(`build contains stale JavaScript: ${unexpected.join(", ")}`);

  const nonRuntime = walk(dist)
    .map(relative)
    .filter((file) => /\.(?:ts|mjs|cjs)$/.test(file));
  if (nonRuntime.length) {
    failures.push(`dist contains source or alternate-module files: ${nonRuntime.join(", ")}`);
  }

  for (const target of runtimeTargets()) {
    if (!target.startsWith("dist/")) {
      failures.push(`runtime package target must use dist/: ${target}`);
    } else if (!fs.existsSync(path.join(root, target))) {
      failures.push(`runtime package target is missing: ${target}`);
    }
  }

  for (const file of emitted) {
    const absolute = path.join(root, file);
    const source = fs.readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.endsWith(".js")) {
        failures.push(`${file} has a non-JavaScript relative import: ${specifier}`);
        continue;
      }
      if (!fs.existsSync(path.resolve(path.dirname(absolute), specifier))) {
        failures.push(`${file} has an unresolved relative import: ${specifier}`);
      }
    }
  }

  for (const executable of ["dist/bin/betterwright.js", "dist/src/worker.js"]) {
    const mode = fs.statSync(path.join(root, executable)).mode;
    if ((mode & 0o111) === 0) failures.push(`${executable} is not executable`);
  }

  for (const standalone of [
    "dist/src/cdpfree/extension/background.js",
    "dist/src/vault-sensor.js",
  ]) {
    const source = fs.readFileSync(path.join(root, standalone), "utf8");
    if (/^\s*(?:"use strict";|export\s*\{\s*\};)/m.test(source)) {
      failures.push(`${standalone} must remain a classic non-strict script`);
    }
  }
}

if (failures.length) {
  console.error(`Build checks failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `build layout verified: ${runtimeTargets().length} package targets and ${walk(dist).filter((file) => file.endsWith(".js")).length} JavaScript files`,
);
