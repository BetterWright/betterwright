import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers/temp-dir.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist", "bin", "betterwright.js");
const importGuard = path.join(makeTempDir("betterwright-startup-"), "guard.ts");
fs.writeFileSync(importGuard, String.raw`
  import { plugin } from "bun";
  plugin({
    name: "reject-eager-setup-imports",
    setup(build) {
      build.onLoad({ filter: /[\\/](doctor|chromium-fork-install)\.js$/ }, ({ path }) => {
        throw new Error("Unexpected setup module: " + path);
      });
    },
  });
`);

function runWithoutSetupModules(args: string[], model?: string) {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.BETTERWRIGHT_MODEL_BASE_URL;
  delete env.BETTERWRIGHT_MODEL_API_KEY;
  if (model === undefined) delete env.BETTERWRIGHT_MODEL;
  else env.BETTERWRIGHT_MODEL = model;
  return spawnSync(process.execPath, ["--preload", importGuard, cli, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("CLI help and version do not load setup modules", () => {
  for (const args of [["--help"], ["--version"], ["run", "--help"], ["setup", "--help"]]) {
    const result = runWithoutSetupModules(args);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.notEqual(result.stdout.trim(), "");
  }
});

test("invalid setup flags fail before loading the installer", () => {
  for (const args of [["setup", "--chromium"], ["update", "--cloak-only"]]) {
    const result = runWithoutSetupModules(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no longer/);
    assert.doesNotMatch(result.stderr, /Unexpected setup module/);
  }
});

test("explicit CLI and environment models bypass default model discovery", () => {
  for (const selection of [
    { args: ["--model=openrouter/vendor/model"], model: "different-default" },
    { args: ["--model", "openrouter/vendor/model"], model: undefined },
    { args: [], model: "openrouter/vendor/model" },
  ]) {
    const result = runWithoutSetupModules(["exec", "inspect example.com", ...selection.args], selection.model);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OpenRouter needs an API key.*OPENROUTER_API_KEY/s);
    assert.doesNotMatch(result.stderr, /Unexpected setup module/);
  }
});

test("an absent or empty environment model still loads default model discovery", () => {
  for (const model of [undefined, ""]) {
    const result = runWithoutSetupModules(["exec", "inspect example.com"], model);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unexpected setup module: .*doctor\.js/);
  }
});
