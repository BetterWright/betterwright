#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const lockRoot = lock.packages?.[""] || {};
const failures = [];

function expectMatch(label, text, expression, expected) {
  const actual = text.match(expression)?.[1];
  if (actual !== expected) failures.push(`${label}: expected ${expected}, found ${actual ?? "nothing"}`);
}

if (lock.version !== pkg.version || lockRoot.version !== pkg.version) {
  failures.push(
    `package-lock.json version must be ${pkg.version}; found ${lock.version}/${lockRoot.version}`,
  );
}
// These are pinned exactly on purpose. playwright-core ships a coupled
// browser driver, and tldts carries the Public Suffix List snapshot that
// `getDomain` uses to decide a credential's base-domain scope in vault.ts —
// so a routine bump there silently widens which origins a saved credential is
// offered to. Drift in either of them must fail the release.
for (const dependency of ["playwright-core", "tldts"]) {
  if (lockRoot.dependencies?.[dependency] !== pkg.dependencies[dependency]) {
    failures.push(`package-lock.json ${dependency} pin does not match package.json`);
  }
}
// patchright-core is optional but must track playwright-core exactly: patchright
// republishes playwright's releases 1:1 and swaps in a patched driver, so a
// caret range there can float the stealth driver out of lockstep with the
// pinned playwright-core it is meant to shadow.
const patchright = pkg.optionalDependencies?.["patchright-core"];
if (patchright !== pkg.dependencies["playwright-core"]) {
  failures.push(
    `patchright-core must be pinned to playwright-core's exact version ${pkg.dependencies["playwright-core"]}; found ${patchright ?? "nothing"}`,
  );
}
if (lockRoot.optionalDependencies?.["patchright-core"] !== patchright) {
  failures.push("package-lock.json patchright-core pin does not match package.json");
}
const npmVersion = String(pkg.packageManager || "").match(/^npm@(.+)$/)?.[1];
if (!npmVersion) failures.push("packageManager must pin an exact npm version");
else {
  expectMatch(
    "publish workflow npm version",
    read(".github/workflows/publish-npm.yml"),
    /npm install --global npm@([^\s]+)/,
    npmVersion,
  );
}

expectMatch(
  "Node runtime Playwright pin",
  read("src/doctor.ts"),
  /PINNED_PLAYWRIGHT_VERSION = "([^"]+)"/,
  pkg.dependencies["playwright-core"],
);
// BetterChromium release identity and archive pins must move in lockstep.
const chromiumSource = read("src/chromium-fork.ts");
const chromiumVersion = chromiumSource.match(/BETTERWRIGHT_CHROMIUM_VERSION = "([^"]+)"/)?.[1];
if (!chromiumVersion) failures.push("BetterChromium version pin is missing");
else if (!/CHROMIUM_FORK_RELEASE_TAG = `betterchromium-\$\{BETTERWRIGHT_CHROMIUM_VERSION\}-r[0-9]+`/.test(chromiumSource)) {
  failures.push("BetterChromium release tag must be versioned as betterchromium-<version>-rN");
}
const assetEntries = [...chromiumSource.matchAll(/name: "(betterchromium-(?:mac-arm64|linux-x64|win-x64)\.zip)",\s+sha256:\s+"([a-f0-9]{64})"/g)];
const declaredAssetNames = [...chromiumSource.matchAll(/name: "([^"]+)"/g)].map((match) => match[1]);
if (assetEntries.length !== declaredAssetNames.length) {
  failures.push("every BetterChromium asset must use a betterchromium-* filename and verified SHA-256");
}
if (declaredAssetNames.some((name) => name.includes("win-x64")) &&
    !assetEntries.some(([_, name]) => name === "betterchromium-win-x64.zip")) {
  failures.push("Windows x64 must not enter the BetterChromium manifest without a verified checksum");
}

// CI and trusted publishing must exercise the BetterChromium install.
for (const workflow of [".github/workflows/ci.yml", ".github/workflows/publish-npm.yml"]) {
  const source = read(workflow);
  const managedSetup = source.match(
    /- name: Install managed browser(?:s)?\n(?:\s+if:[^\n]+\n)?\s+run:\s*([^\n]+)/,
  )?.[1]?.trim();
  if (managedSetup !== "node dist/bin/betterwright.js setup") {
    failures.push(`${workflow} must install BetterChromium with default setup`);
  }
}

const tagIndex = process.argv.indexOf("--tag");
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1] || "";
  if (tag !== `v${pkg.version}`) failures.push(`release tag ${tag || "<empty>"} does not match v${pkg.version}`);
}

if (failures.length) {
  console.error(`Version checks failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `versions aligned: betterwright ${pkg.version}, BetterChromium ${chromiumVersion}, playwright-core ${pkg.dependencies["playwright-core"]}`,
);
